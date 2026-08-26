# Ảnh responsive trên R2

Source này giữ nguyên file gốc và tự tạo các bản WebP nhỏ ngay trong trình duyệt trước khi upload lên R2.

## Bản vá 1.0.1

- Sửa lỗi upload `KV PUT failed: 413 Payload Too Large` khi ảnh tạo nhiều bản responsive.
- Metadata đầy đủ được lưu trong KV value; KV metadata chỉ giữ bản gọn dưới giới hạn 1024 byte của Cloudflare.
- Tương thích dữ liệu cũ: record cũ chỉ có KV metadata vẫn được đọc bình thường.

## Quy tắc tạo ảnh

- Các chiều rộng chuẩn: `480`, `960`, `1600` px.
- Chỉ tạo bản có chiều rộng nhỏ hơn ảnh gốc; không bao giờ upscale.
- JPEG, PNG và WebP tĩnh được tạo bản responsive với WebP quality `0.92` và nội suy chất lượng cao.
- GIF, APNG, WebP động, video, file không phải ảnh và ảnh rộng không quá 480 px chỉ lưu bản gốc.
- File gốc không bị nén lại, nên link gốc luôn giữ nguyên chất lượng ban đầu.
- Khi xóa một ảnh quản lý, bản gốc và toàn bộ biến thể R2 cũng được xóa cùng nhau.

Ví dụ:

| Rộng ảnh gốc | Các bản được tạo |
| ---: | --- |
| 3840 px | 480, 960, 1600 px |
| 1200 px | 480, 960 px |
| 700 px | 480 px |
| 480 px trở xuống | Không tạo thêm |

## URL sử dụng

Link gốc vẫn không đổi:

```text
https://img.example.com/file/ABC123
```

Yêu cầu đúng một size bằng query `w`:

```text
https://img.example.com/file/ABC123?w=480
https://img.example.com/file/ABC123?w=960
https://img.example.com/file/ABC123?w=1600
```

Nếu size yêu cầu không tồn tại, server tự trả file gốc. Chỉ ba giá trị trên được công nhận; giá trị khác cũng trở về file gốc.

Ví dụ HTML cho ảnh lớn có đủ các biến thể:

```html
<img
  src="https://img.example.com/file/ABC123"
  srcset="
    https://img.example.com/file/ABC123?w=480 480w,
    https://img.example.com/file/ABC123?w=960 960w,
    https://img.example.com/file/ABC123?w=1600 1600w
  "
  sizes="(max-width: 767px) 100vw, 96rem"
  loading="lazy"
  decoding="async"
  alt=""
>
```

R2 object dùng cache header một năm `immutable`. Route `/file/...` cũng dùng Cloudflare Cache API khi runtime hỗ trợ, tách cache theo URL query.

## Kiểm tra

```bash
npm install
npm test
```
