# MCW Edge CDN & Hotfix Proxy

Hạ tầng phân phối tệp tải xuống tốc độ cao và cổng phân phối bản vá Hotfix khẩn cấp cho **MCW Launcher**, vận hành trên nền tảng **Cloudflare Pages & Edge Functions**.

---

## 🚀 Tính Năng Chính
1. **Edge Cache Proxy**:
   - Tự động nạp và lưu bộ nhớ đệm (Cache 30 ngày) các tệp phát hành từ GitHub Releases tại các PoP Việt Nam (Hà Nội `HAN`, TP.HCM `SGN`).
   - Hỗ trợ HTTP Range requests (`bytes=...`) cho các trình tăng tốc tải xuống (IDM, Free Download Manager) và tính năng tiếp tục tải khi đứt mạng (Resumable Download).
2. **Kênh Hotfix Khẩn Cấp (v1.7+)**:
   - Cung cấp manifest `manifest.json` định tuyến bản vá tức thì với TTL 60 giây.
   - Cho phép launcher tự động cập nhật logic mà không cần người dùng tải lại bản `.exe` 80MB.
3. **Chẩn Đoán Kết Nối Edge (`/health`)**:
   - Giám sát trạng thái hoạt động, độ trễ và PoP Cloudflare theo thời gian thực.

---

## 🛠️ Hướng Dẫn Triển Khai Lên Cloudflare Pages

### Cách 1: Kết nối kho lưu trữ GitHub (Khuyến nghị)
1. Đẩy mã nguồn thư mục này lên GitHub với tên repo: `mahiru7229/mcw-download`.
2. Truy cập [Cloudflare Dashboard](https://dash.cloudflare.com) > **Workers & Pages** > **Create application** > **Pages** > **Connect to Git**.
3. Chọn repo `mahiru7229/mcw-download`.
4. Cấu hình cài đặt:
   - **Project name**: `mcw-download` (Sẽ nhận domain miễn phí `https://mcw-download.pages.dev`)
   - **Framework preset**: `None`
   - **Build command**: *(để trống)*
   - **Build output directory**: `public`
5. Bấm **Save and Deploy**. Toàn bộ hệ thống tải CDN VN và Hotfix sẽ hoạt động ngay lập tức!

### Cách 2: Triển khai trực tiếp qua Wrangler CLI
```powershell
# Chạy thử nghiệm local
npx wrangler pages dev public

# Triển khai trực tiếp
npx wrangler pages deploy public --project-name=mcw-download
```

---

## 📡 Danh Mục API Endpoints

| Tuyến Đường (Route) | Mục Đích |
|---|---|
| `GET /releases/:tag/:filename` | Tải file cài đặt/cập nhật qua Edge CDN VN |
| `GET /hotfixes/manifest.json` | Nhận danh sách bản vá Hotfix khẩn cấp |
| `GET /health` | Kiểm tra trạng thái PoP và độ trễ mạng |
