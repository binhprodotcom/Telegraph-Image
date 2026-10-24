import {jpegDimensions} from '../font-finder/[[path]].js';
const WP='https://dafont.vn/wp-json/dfvn-service-media/v1/authorize',ORIGIN='https://dafont.vn';
const UUID='[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
const headers={'Access-Control-Allow-Origin':ORIGIN,'Access-Control-Allow-Methods':'POST,GET,HEAD,OPTIONS','Access-Control-Allow-Headers':'Authorization,Content-Type','Access-Control-Expose-Headers':'X-DFVN-Image-SHA256,Content-Length','Vary':'Origin','Cache-Control':'private, no-store, max-age=0','X-Robots-Tag':'noindex,nofollow','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'};
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{...headers,'Content-Type':'application/json'}});
export async function onRequest({request,env}){
 const url=new URL(request.url),origin=request.headers.get('Origin');if(origin&&origin!==ORIGIN)return json({error:'Denied'},403);
 if(request.method==='OPTIONS')return new Response(null,{status:origin===ORIGIN?204:403,headers});
 if(!env.IMAGE_BUCKET)return json({error:'Storage unavailable'},503);
 const path=url.pathname.replace(/^\/api\/service-chat\//,'');if(path==='status'&&request.method==='GET')return json({ready:true,version:1,retentionDays:30});
 const match=path.match(new RegExp('^(upload|delete|image)/('+UUID+')(\\.jpg)?$'));if(!match||((match[1]==='image')!==!!match[3]))return json({error:'Not found'},404);
 const [,route,asset]=match,operation=route==='image'?'read':route;
 if(!((route==='image'&&['GET','HEAD'].includes(request.method))||(route!=='image'&&request.method==='POST')))return json({error:'Method'},405);
 if(route==='upload'&&origin!==ORIGIN)return json({error:'Origin required'},403);
 const token=(request.headers.get('Authorization')||'').replace(/^Bearer /,'')||url.searchParams.get('ticket')||'';
 if(!/^(?:[a-f0-9]{64}|[0-9]{10}\.[a-f0-9]{64})$/.test(token))return json({error:'Not found'},404);
 try{
  const reply=await fetch(WP,{method:'POST',redirect:'manual',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation,asset,token}),signal:AbortSignal.timeout(10000)});
  const permit=reply.ok?await reply.json():null;
  if(!permit?.allowed||permit.asset!==asset||!new RegExp('^service-chat/[a-f0-9]{64}/'+asset+'\\.jpg$').test(permit.key||''))return json({error:'Not found'},404);
  const key=permit.key;
  if(route==='delete'){await env.IMAGE_BUCKET.delete(key);return json({deleted:true});}
  if(route==='upload'){
   if(request.headers.get('Content-Type')!=='image/jpeg')return json({error:'JPEG required'},415);
   if(Number(request.headers.get('Content-Length')||0)>2*1024*1024)return json({error:'Too large'},413);
   const reader=request.body?.getReader();if(!reader)return json({error:'Image required'},400);const parts=[];let size=0;
   while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>2*1024*1024){await reader.cancel();return json({error:'Too large'},413);}parts.push(value);}
   const bytes=new Uint8Array(size);let at=0;for(const part of parts){bytes.set(part,at);at+=part.length;}
   const sha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
   if(size!==permit.bytes||sha!==permit.sha256)return json({error:'Image differs'},422);
   let dimensions;try{dimensions=jpegDimensions(bytes);}catch{return json({error:'Invalid JPEG'},422);}
   if(dimensions.width>1600||dimensions.height>1600||dimensions.width!==permit.width||dimensions.height!==permit.height)return json({error:'Dimensions differ'},422);
   const existing=await env.IMAGE_BUCKET.head(key);if(existing&&existing.customMetadata?.sha256!==sha)return json({error:'Conflict'},409);
   if(!existing)await env.IMAGE_BUCKET.put(key,bytes,{httpMetadata:{contentType:'image/jpeg',cacheControl:'private, no-store'},customMetadata:{kind:'dfvn-service-chat',sha256:sha,width:String(dimensions.width),height:String(dimensions.height)}});
   return json({asset,bytes:size});
  }
  const object=request.method==='HEAD'?await env.IMAGE_BUCKET.head(key):await env.IMAGE_BUCKET.get(key);if(!object)return json({error:'Not found'},404);
  return new Response(request.method==='HEAD'?null:object.body,{headers:{...headers,'Content-Type':'image/jpeg','Content-Length':String(object.size),'Content-Disposition':'inline; filename="service-image.jpg"','X-DFVN-Image-SHA256':object.customMetadata?.sha256||''}});
 }catch{return json({error:'Image service temporarily unavailable'},503);}
}
