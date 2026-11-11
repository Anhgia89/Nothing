# TruyenTruyenTV

Trang đọc truyện chữ tiếng Việt chạy bằng Node.js, SQLite và Electron. Tài khoản, số dư coin, tập đã mở khóa và lịch sử đọc được lưu trên máy chủ, không phụ thuộc dữ liệu trình duyệt. Mỗi tập giá 2 coin; điểm danh nhận 10 coin mỗi ngày theo giờ Việt Nam.

Mỗi tập được đăng bán phải có từ 2.000 đến 5.000 từ (đếm theo khoảng trắng). Các truyện minh họa đã có sẵn là đoạn trích mẫu: không thể mua hoặc tạo audio cho tới khi Admin thay nội dung bằng một tập đủ độ dài.

## Chạy trên máy phát triển

Cần Node.js 22.12 trở lên.

```powershell
npm.cmd start
```

Mở `http://localhost:3000`. Cơ sở dữ liệu được tạo tại `data/truyentruyentv.sqlite`. Máy chủ tạo mã thiết lập Admin ngẫu nhiên một lần và lưu tại `data/admin-setup-key.txt`; sau khi khởi động, đăng ký tài khoản bằng email Admin đã cấu hình trong `.env`, mở hồ sơ và nhập mã này. Mã sẽ bị xóa sau khi quyền Admin được thiết lập.

Chạy ứng dụng desktop Electron bằng:

```powershell
npm.cmd run desktop
```

Ứng dụng Electron lưu dữ liệu riêng trong thư mục dữ liệu của Electron trên máy đó; nó không tự đồng bộ với cơ sở dữ liệu website chạy bằng `npm.cmd start`. Muốn dùng chung tài khoản giữa nhiều người/thiết bị, hãy truy cập địa chỉ website đã triển khai.

## Đưa website lên mạng

Triển khai ứng dụng trên một máy chủ Node.js 22.12+ có ổ đĩa bền vững. Cấu hình các biến môi trường trên dịch vụ lưu trữ; không đưa mã Admin hoặc cơ sở dữ liệu vào Git:

| Biến | Mục đích |
|---|---|
| `NODE_ENV=production` | Bật cookie `Secure` và tắt nạp coin thử nghiệm. |
| `ADMIN_EMAIL` | Email dùng để đăng ký tài khoản Admin đầu tiên. |
| `ADMIN_SETUP_KEY` | Mã ngẫu nhiên, dài và bí mật để kích hoạt quyền Admin đúng một lần. |
| `DATA_DIR` | Thư mục dữ liệu bền vững, có quyền ghi. |
| `HOST=0.0.0.0` | Lắng nghe các kết nối của nền tảng triển khai. |
| `PORT` | Cổng được nền tảng triển khai cấp. |
| `ELEVENLABS_API_KEY` | API key ElevenLabs; chỉ lưu trong biến môi trường/phần quản lý secrets phía máy chủ. |
| `ELEVENLABS_ADAM_VOICE_ID` | Voice ID giọng Adam có khả năng đọc tiếng Việt. |
| `ELEVENLABS_EVA_VOICE_ID` | Voice ID giọng Eva có khả năng đọc tiếng Việt. |

Tạo mã bí mật bằng `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"` rồi lưu trực tiếp vào cấu hình bí mật của nền tảng. Dùng HTTPS ở reverse proxy/hosting; cookie phiên sản xuất chỉ gửi qua HTTPS. Giữ một bản sao lưu SQLite định kỳ. SQLite phù hợp cho một máy chủ/instance có ổ đĩa bền vững; dùng cơ sở dữ liệu máy chủ như PostgreSQL nếu cần nhiều instance đồng thời. `npm.cmd run start:public` chạy cùng server trên máy chủ triển khai.

## Đăng nhập và quản trị

- Khách phải tạo tài khoản hoặc đăng nhập để dùng thư viện, điểm danh, nạp thử và lưu tiến trình đọc.
- Khu vực Trò chơi cho phép tài khoản chiến đấu để nhận 25 XP mỗi lượt; cứ đủ XP lên một cấp sẽ nhận đúng 1 coin. Tiến trình và phần thưởng được lưu, xác thực ở máy chủ.
- Tài khoản được tạo với quyền độc giả. Email Admin không tự nhận quyền: tài khoản phải nhập đúng `ADMIN_SETUP_KEY`, và chỉ tài khoản đầu tiên được thiết lập.
- Admin có thể đăng/ẩn truyện chữ, thêm tập, khóa/mở khóa tài khoản độc giả và chỉnh tên/dòng giới thiệu website.
- Admin có thể thay nội dung tập mẫu hoặc sửa tập hiện có; giao diện đếm từ và máy chủ đều kiểm tra giới hạn 2.000–5.000 từ.
- Tên truyện, mô tả, đoạn xem thử và nội dung tập là văn bản thuần; không hỗ trợ ảnh bìa.
- Audio sử dụng SDK ElevenLabs với model `eleven_v4`, mã ngôn ngữ tiếng Việt và chuẩn hóa văn bản để ưu tiên chất lượng đọc truyện. Sau khi cấu hình API key cùng hai voice ID, độc giả có thể chọn Adam hoặc Eva để nghe tập đã mở khóa; API key không được gửi xuống trình duyệt. Hãy xác nhận voice ID hỗ trợ phát âm tiếng Việt. Khởi động lại máy chủ sau khi thay đổi biến môi trường.
- Các nút nạp coin chỉ mô phỏng khi chạy phát triển. Ở production, API từ chối nạp coin cho đến khi tích hợp cổng thanh toán. Đăng ký chưa xác minh email và chưa có luồng quên/đặt lại mật khẩu; cần bổ sung nhà cung cấp email trước khi mở đăng ký công khai rộng rãi.
- Truyện mẫu trong cơ sở dữ liệu là nội dung minh họa gốc; chỉ đăng truyện bên thứ ba khi có quyền sử dụng.

## Kiểm tra

```powershell
npm.cmd run check
npm.cmd test
```
