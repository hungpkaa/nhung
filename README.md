# Smart Garden ESP32 Wokwi

Đề tài: **Thiết kế và mô phỏng hệ thống vườn cây thông minh giám sát và điều khiển qua web sử dụng ESP32**.

Project dùng web dashboard riêng. ESP32 trên Wokwi không host web server; ESP32 hoặc simulator gửi dữ liệu lên backend và đọc lệnh điều khiển từ backend.

## Kiến trúc

```text
ESP32 trên Wokwi hoặc simulator local
  -> HTTP POST dữ liệu cảm biến
Backend Node.js / Express
  -> Lưu SQLite
Web Dashboard
  -> Hiển thị, vẽ biểu đồ, gửi lệnh điều khiển
ESP32 hoặc simulator
  -> GET lệnh mới nhất và thực thi
```

## Chức năng chính

- Đọc cảm biến Soil Moisture, DHT22, LDR, Water Level.
- Tưới tự động theo độ ẩm đất.
- Chế độ Auto / Manual.
- Điều khiển bơm thủ công từ dashboard.
- Bật / tắt hệ thống.
- Chỉnh ngưỡng đất khô, đất quá ẩm, ánh sáng yếu, thiếu nước và thời gian bơm tối đa.
- Cảnh báo đất khô, đất quá ẩm, thiếu nước, ánh sáng yếu và bơm quá thời gian.
- Đèn cây tự bật khi ánh sáng yếu.
- Lưu lịch sử cảm biến vào SQLite.
- Biểu đồ độ ẩm đất, nhiệt độ, mực nước và ánh sáng.
- Trạng thái thông minh, thống kê cảnh báo/bơm và nút kịch bản demo.

## Cấu trúc thư mục

```text
src/server.js          Backend Express + SQLite
src/simulator.js       Bộ mô phỏng ESP32 chạy local
public/                Web dashboard HTML/CSS/JS + Chart.js
wokwi/sketch.ino       Code ESP32 gửi HTTP lên backend
wokwi/diagram.json     Mạch mô phỏng Wokwi
data/                  SQLite database tạo tự động khi chạy server
```

## Chạy project local

Terminal 1 chạy backend và dashboard:

```bash
npm install
npm start
```

Khi tải project từ source sạch, không cần copy `node_modules`. Database SQLite trong `data/` sẽ được backend tạo tự động khi chạy lần đầu.

Mở dashboard:

```text
http://localhost:3000
```

Terminal 2 chạy ESP32 simulator local:

```bash
npm run simulate
```

Simulator sẽ đọc lệnh từ `/api/control`, tạo dữ liệu cảm biến và gửi vào `/api/sensor` mỗi 10 giây. Dashboard vẫn tự refresh thường xuyên, nhưng điểm dữ liệu mới trên biểu đồ sẽ tăng khoảng 10 giây/lần.

## Cơ chế tự cân bằng

- Khi đất khô, chế độ Auto bật bơm để đưa độ ẩm đất về vùng cân bằng.
- Khi bơm chạy, độ ẩm đất tăng và mực nước giảm.
- Khi bơm tắt, đất khô dần theo ánh sáng và nhiệt độ.
- Khi đất đủ ẩm, bơm tự tắt để tránh tưới quá nhiều.
- Khi thiếu nước, bơm tắt, còi cảnh báo bật và simulator mô phỏng việc bổ sung nước sau vài chu kỳ.
- Khi ánh sáng yếu, đèn cây bật và ánh sáng tăng dần.
- Khi bơm chạy quá thời gian giới hạn, bơm tắt và hệ thống chờ chu kỳ sau mới cho phép điều khiển lại.

## Kịch bản demo

Dashboard có khu **Kịch bản demo** để tạo tình huống nhanh khi thuyết trình:

- **Đất khô**: kéo độ ẩm đất xuống dưới ngưỡng để Auto bật bơm.
- **Thiếu nước**: kéo mực nước xuống thấp để bật cảnh báo và tắt bơm.
- **Ánh sáng yếu**: kéo ánh sáng xuống thấp để bật đèn cây.
- **Reset**: đưa môi trường về vùng ổn định.

Các kịch bản này giúp biểu đồ và trạng thái thay đổi có logic, dễ chứng minh hệ thống không chỉ hiển thị dữ liệu mà còn phản ứng để đưa vườn về trạng thái an toàn.

## API

| API | Chức năng |
| --- | --- |
| `GET /api/health` | Kiểm tra backend đang chạy |
| `POST /api/sensor` | ESP32/simulator gửi dữ liệu cảm biến |
| `GET /api/latest` | Web lấy dữ liệu mới nhất |
| `GET /api/history` | Web lấy lịch sử để vẽ biểu đồ |
| `GET /api/summary` | Web lấy thống kê bơm và cảnh báo |
| `GET /api/control` | ESP32/simulator lấy lệnh điều khiển, cài đặt và kịch bản |
| `POST /api/control` | Web gửi lệnh System/Mode/Pump |
| `POST /api/settings` | Web cập nhật ngưỡng và thời gian bơm tối đa |
| `GET /api/scenario` | Lấy kịch bản demo hiện tại |
| `POST /api/scenario` | Gửi kịch bản demo mới |

Ví dụ gửi dữ liệu cảm biến:

```json
{
  "soil": 43,
  "temperature": 29.5,
  "airHumidity": 70,
  "light": 62,
  "waterLevel": 80,
  "pump": false,
  "buzzer": false,
  "growLight": true,
  "systemOn": true,
  "mode": "AUTO",
  "status": "Độ ẩm đất đang phù hợp"
}
```

Ví dụ gọi kịch bản demo:

```bash
curl -X POST http://localhost:3000/api/scenario \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"dry_soil\"}"
```

Kiểm tra nhanh dữ liệu:

```bash
curl http://localhost:3000/api/latest
curl http://localhost:3000/api/summary
curl http://localhost:3000/api/history?limit=5
```

## Chạy với Wokwi

Trong `wokwi/sketch.ino`, sửa host nếu dùng ngrok hoặc backend public. Chỉ điền hostname, không kèm `http://` hoặc `https://`:

```cpp
const char* SERVER_HOST = "your-ngrok-host-here";
const int SERVER_PORT = 80;
```

Ví dụ nếu ngrok hiển thị URL `https://abc-123.ngrok-free.app`, thì `SERVER_HOST` là `abc-123.ngrok-free.app`.

Sketch hiện dùng HTTP qua port `80`. Nếu backend public của bạn bắt buộc HTTPS, cần đổi sketch sang `WiFiClientSecure` và port `443`, hoặc dùng gateway/tunnel hỗ trợ HTTP.

Nếu backend chỉ chạy trên máy cá nhân:

- Wokwi Public Gateway cho phép ESP32 gọi Internet nhưng không gọi trực tiếp `localhost`.
- Muốn ESP32 truy cập service local có thể dùng Private Wokwi IoT Gateway và `host.wokwi.internal`.
- Cách demo local ổn định nhất là dùng `npm run simulate`.

## Luồng điều khiển

1. ESP32 hoặc simulator đọc cảm biến và `POST /api/sensor`.
2. Web dashboard gọi `GET /api/latest`, `GET /api/history` và `GET /api/summary`.
3. Người dùng bấm bật/tắt hệ thống, Auto/Manual, bơm thủ công hoặc kịch bản demo.
4. Web gửi `POST /api/control` hoặc `POST /api/scenario`.
5. ESP32 hoặc simulator gọi `GET /api/control`.
6. ESP32 hoặc simulator thực hiện lệnh và gửi trạng thái mới về server.
