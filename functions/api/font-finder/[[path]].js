// Narrow WordPress media bridge. Existing image-host login/API routes remain unchanged.
const WP = 'https://dafont.vn/wp-json/dfvn-ff-media/v1/authorize';
const ORIGIN = 'https://dafont.vn';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAX = 5 * 1024 * 1024;
const cors = { 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Methods': 'POST, GET, HEAD, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Expose-Headers': 'X-DFVN-Image-SHA256, Content-Length', 'Vary': 'Origin', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex, nofollow' };
const json = (body,status=200) => new Response(JSON.stringify(body),{status,headers:{...cors,'Content-Type':'application/json'}});
const bearer = request => (request.headers.get('Authorization')||'').replace(/^Bearer /,'');
async function authorize(body) {
  const r = await fetch(WP,{method:'POST',redirect:'manual',headers:{'Content-Type':'application/json','Accept':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(12000)});
  if(!r.ok) return null;
  const data=await r.json();return data?.allowed===true&&data.asset===body.asset?data:null;
}
export function jpegDimensions(bytes) {
  if(bytes.length<12||bytes[0]!==255||bytes[1]!==216||bytes[bytes.length-2]!==255||bytes[bytes.length-1]!==217)throw new Error('Invalid JPEG');
  let i=2,dim=null;
  while(i<bytes.length-2){if(bytes[i++]!==255)throw new Error('JPEG marker');while(bytes[i]===255)i++;const marker=bytes[i++];if(marker===218)break;if(marker===216||marker===217||(marker>=208&&marker<=215))continue;const n=bytes[i]*256+bytes[i+1];if(n<2||i+n>bytes.length)throw new Error('JPEG segment');if([192,193,194].includes(marker)){if(n<8)throw new Error('JPEG dimensions');const h=bytes[i+3]*256+bytes[i+4],w=bytes[i+5]*256+bytes[i+6];if(w<32||h<32||w>1800||h>1800||w*h>3240000)throw new Error('JPEG dimensions');dim={width:w,height:h};}if((marker>=224&&marker<=239)||marker===254)throw new Error('JPEG metadata is not allowed');i+=n;}
  if(!dim)throw new Error('JPEG dimensions missing');return dim;
}
export async function onRequest(context) {
  const {request,env}=context;const url=new URL(request.url);const origin=request.headers.get('Origin');
  if(origin&&origin!==ORIGIN)return json({error:'Origin denied'},403);
  if(request.method==='OPTIONS')return origin===ORIGIN?new Response(null,{status:204,headers:cors}):json({error:'Origin denied'},403);
  if(!env.IMAGE_BUCKET)return json({error:'Storage unavailable'},503);
  const path=url.pathname.replace(/^\/api\/font-finder\//,'');
  if(path==='status'&&request.method==='GET')return json({ready:true,version:1,upload:'direct-r2',pending:'private'});
  const image=path.match(/^image\/([a-f0-9-]{36})\.jpg$/);const upload=path.match(/^upload\/([a-f0-9-]{36})$/);const discard=path.match(/^discard\/([a-f0-9-]{36})$/);const asset=image?.[1]||upload?.[1]||discard?.[1];
  if(!asset||!UUID.test(asset))return json({error:'Not found'},404);
  const key='font-finder/'+asset+'.jpg';
  let stage='start';
  try{
    if(discard&&request.method==='POST'){if(origin!==ORIGIN)return json({error:'Origin required'},403);const token=bearer(request);if(!/^[a-f0-9]{64}$/.test(token)||!await authorize({operation:'discard',asset,token}))return json({error:'Ticket expired'},403);await env.IMAGE_BUCKET.delete(key);return json({discarded:true});}
    if(upload&&request.method==='POST'){
      if(origin!==ORIGIN)return json({error:'Origin required'},403);
      const token=bearer(request);if(!/^[a-f0-9]{64}$/.test(token))return json({error:'Ticket required'},403);
      stage='authorize';const permit=await authorize({operation:'upload',asset,token});if(!permit)return json({error:'Ticket expired'},403);
      if(request.headers.get('Content-Type')!=='image/jpeg')return json({error:'JPEG required'},415);
      if(Number(request.headers.get('Content-Length')||0)>MAX)return json({error:'Too large'},413);
      const reader=request.body?.getReader();if(!reader)return json({error:'Image required'},400);const chunks=[];let size=0;
      while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>MAX){await reader.cancel();return json({error:'Too large'},413);}chunks.push(value);}
      const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}
      const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
      if(size!==permit.bytes||digest!==permit.sha256)return json({error:'Image differs from ticket'},422);
      stage='jpeg';const dimensions=jpegDimensions(bytes);if(dimensions.width!==permit.width||dimensions.height!==permit.height)return json({error:'Dimensions differ'},422);
      stage='r2-head';const existing=await env.IMAGE_BUCKET.head(key);
      if(existing&&existing.customMetadata?.sha256!==digest)return json({error:'Asset conflict'},409);
      stage='r2-put';if(!existing)await env.IMAGE_BUCKET.put(key,bytes,{httpMetadata:{contentType:'image/jpeg',cacheControl:'private, no-store'},customMetadata:{sha256:digest,width:String(dimensions.width),height:String(dimensions.height),createdAt:new Date().toISOString(),kind:'dfvn-font-finder'}});
      return json({asset,sha256:digest,bytes:size,...dimensions});
    }
    if(image&&['GET','HEAD'].includes(request.method)){
      const token=bearer(request)||url.searchParams.get('ticket')||'';
      const edge=typeof caches!=='undefined'?caches.default:null;const cacheKey=new Request(url.origin+url.pathname,{method:'GET'});
      if(!token&&edge){const cached=await edge.match(cacheKey);if(cached){const headers=new Headers(cached.headers);headers.set('Cache-Control','no-store, max-age=0');headers.set('X-DFVN-Edge-Cache','HIT');return new Response(request.method==='HEAD'?null:cached.body,{status:200,headers});}}
      const permit=await authorize({operation:'read',asset,token});if(!permit)return json({error:'Not found'},404);
      const object=request.method==='HEAD'?await env.IMAGE_BUCKET.head(key):await env.IMAGE_BUCKET.get(key);if(!object)return json({error:'Not found'},404);
      const headers={...cors,'Content-Type':'image/jpeg','Content-Length':String(object.size),'Content-Disposition':'inline; filename="font-reference.jpg"','X-DFVN-Image-SHA256':object.customMetadata?.sha256||'','Referrer-Policy':'no-referrer'};
      if(permit.public===true){headers['Cache-Control']='public, max-age=60';headers['X-Robots-Tag']='index, follow, max-image-preview:large';}
      const response=new Response(request.method==='HEAD'?null:object.body,{status:200,headers});
      if(permit.public===true&&!token&&edge&&request.method==='GET'){const write=edge.put(cacheKey,response.clone());if(context.waitUntil)context.waitUntil(write);else await write;}
      if(permit.public===true){response.headers.set('Cache-Control','no-store, max-age=0');response.headers.set('X-DFVN-Edge-Cache','MISS');}
      return response;
    }
    return json({error:'Method not allowed'},405);
  }catch(error){console.error('dfvn_ff_media',stage,String(error?.message||'error').slice(0,180));return json({error:'Image service temporarily unavailable',stage},503);}
}
