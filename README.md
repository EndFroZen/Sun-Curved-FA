<p align="center">
  <img src="src-tauri/icons/128x128@2x.png" width="128" alt="Sun Curved">
</p>

<h1 align="center">Sun Curved</h1>

<p align="center">โปรแกรมเดสก์ท็อปสำหรับดูแลเซิร์ฟเวอร์ผ่าน SSH ใช้ deploy โปรเจกต์ จัดการไฟล์ cron ฐานข้อมูล และทดสอบ HTTP API ได้ในที่เดียว</p>

---

## Sun Curved คืออะไร

Sun Curved เป็นโปรแกรมบน Windows ที่สร้างด้วย Tauri 2 (Rust + TypeScript) ล็อกอินเข้าเครื่องเซิร์ฟเวอร์ Linux ผ่าน SSH แค่ครั้งเดียว แล้วใช้การเชื่อมต่อนั้นทำงานต่อได้หลายอย่าง ไม่ต้องติดตั้งอะไรเพิ่มบนเครื่องปลายทาง

## ความสามารถหลัก

| ส่วน | ใช้ทำอะไร |
| --- | --- |
| หน้าแรก (Home) | ดูสถานะเครื่องแบบสด ๆ เช่น CPU, RAM, ดิสก์ อ่านจาก `/proc` ผ่าน SSH |
| Deploy | เขียน YAML บอกว่าต้องการ deploy อย่างไร โปรแกรมจะแปลงเป็นสคริปต์ bash แล้วรันบนเครื่องให้ มีโหมดฟอร์ม โหมด YAML และมุมมองขั้นตอนแบบ 3 มิติ |
| Terminal | เทอร์มินัลเต็มรูปแบบ (xterm.js) บนการเชื่อมต่อเดียวกัน |
| Files | เปิด แก้ไข และบันทึกไฟล์บนเครื่องปลายทาง มีตัวแก้ Markdown และ YAML |
| Cron | อ่านและแก้ `crontab` เป็นรายการงาน โดยไม่แตะบรรทัดคอมเมนต์และตัวแปรเดิม |
| BaseCurves | จัดการฐานข้อมูล SQLite, PostgreSQL และ MySQL/MariaDB ดูโครงสร้างตาราง แก้ข้อมูลในตาราง และรัน SQL พร้อมระบบเติมคำอัตโนมัติ |
| Sun Post | เครื่องมือยิง HTTP request สำหรับทดสอบ API |
| Notes | บันทึกโน้ตแบบปฏิทิน รองรับ Markdown และรายการ checkbox |
| SSH Tunnel | เปิดพอร์ตผ่าน SSH เพื่อเข้าถึงบริการบนเครื่องปลายทาง เช่นฐานข้อมูล |

## การ deploy ทำงานอย่างไร

เมื่อกด **Apply** ในหน้า Deploy โปรแกรมจะทำตามลำดับนี้

1. ตรวจ YAML ในโปรแกรมก่อน ถ้าผิดจะแสดงข้อความสีแดงและไม่ส่งอะไรไปที่เครื่อง
2. บันทึก YAML ไว้ที่ `~/EndFroZen/SunCurved/deployments/<name>.yaml`
3. ดึงรายการ tag จาก git และตรวจว่ามีไฟล์ที่ยังไม่ commit หรือไม่
4. ให้เลือก tag ที่จะ deploy และยืนยันการทิ้งการแก้ไขที่ค้างอยู่ (ถ้ามี)
5. แปลง YAML เป็นสคริปต์ bash
6. ส่งสคริปต์เข้า `bash -l -s` บนเครื่องผ่าน stdin และแสดงผลทีละบรรทัดใน Deploy log
7. บันทึกผลลัพธ์ (tag, สำเร็จหรือล้มเหลว, เวลา) ไว้ที่ `~/EndFroZen/SunCurved/state/<name>`

ตัวอย่าง YAML ขั้นต่ำ

```yaml
apiVersion: suncurved/v1
kind: Deployment
metadata:
  name: my-app
spec:
  source:
    repo: github.com/me/my-app
  targets:
    - name: main
      path: ~/apps/my-app
      build: npm ci && npm run build
```

รายละเอียดทุกฟิลด์ ตัวอย่างเพิ่มเติม และวิธีแก้ข้อผิดพลาด ดูได้ที่ [src/manual.md](src/manual.md) หรือเปิดคู่มือจากในโปรแกรม

## ความปลอดภัย

- รหัสผ่านการเชื่อมต่อเก็บใน Windows Credential Manager เท่านั้น ไม่เก็บใน sqlite หรือใน YAML
- รหัส sudo ส่งให้สคริปต์ผ่าน stdin ไม่ปรากฏใน command line และไม่ถูกเขียนลงดิสก์บนเครื่องปลายทาง
- git token เก็บในไฟล์ env บนเครื่องปลายทาง ใช้ผ่าน credential helper ไม่ใส่ใน URL หรือ `.git/config`
- รหัส 2FA ต้องพิมพ์ทุกครั้ง ไม่มีการเก็บไว้
- ไฟล์ YAML เก็บเป็นข้อความธรรมดาบนเครื่องปลายทาง ห้ามใส่ข้อมูลลับใน YAML ให้ใส่ในไฟล์ env แล้ว `chmod 600`

## สิ่งที่ต้องมีก่อนเริ่ม

- Node.js 23.6 ขึ้นไป (สำหรับรันไฟล์ทดสอบ .ts ได้โดยตรง)
- Rust (stable) ผ่าน rustup
- สิ่งที่ Tauri 2 ต้องใช้บน Windows ได้แก่ Microsoft C++ Build Tools และ WebView2 (ดูที่ https://tauri.app/start/prerequisites/)

## การติดตั้งและรัน

```bash
npm install
npm run tauri dev
```

สร้างไฟล์ติดตั้ง

```bash
npm run tauri build
```

ไฟล์ติดตั้งจะอยู่ใน `src-tauri/target/release/bundle/`

## โครงสร้างโปรเจกต์

```
src/                หน้าจอฝั่ง TypeScript
  main.ts           จุดเริ่มต้นและการสลับหน้า
  deploy.ts         แปลง YAML เป็นสคริปต์ bash
  easy.ts           โหมดฟอร์มของหน้า Deploy
  flow.ts           มุมมองขั้นตอน deploy แบบ 3 มิติ
  files.ts          จัดการไฟล์บนเครื่องปลายทาง
  cron.ts           อ่านและเขียน crontab
  basecurves.ts     สร้างคำสั่ง SQL สำหรับตัวแก้ตาราง
  sqlcomplete.ts    เติมคำอัตโนมัติสำหรับ SQL
  post.ts           Sun Post (HTTP client)
  notes.ts          โน้ตปฏิทิน
  stats.ts          สถานะเครื่องจาก /proc
  manual.md         คู่มือ YAML ฉบับเต็ม
src-tauri/          ฝั่ง Rust: SSH, terminal, tunnel และการเก็บรหัสผ่าน
```

## การทดสอบ

ไฟล์ทดสอบอยู่คู่กับโค้ดใน `src/*.test.ts` รันทีละไฟล์ด้วย Node.js 23.6 ขึ้นไป เช่น

```bash
node src/cron.test.ts
```

## ข้อจำกัดในตอนนี้

- ระหว่าง deploy เทอร์มินัลของเครื่องนั้นจะใช้งานไม่ได้จนกว่าจะเสร็จ เพราะใช้การเชื่อมต่อเดียวกัน
- ยังไม่มีปุ่มยกเลิกระหว่าง deploy
- คำสั่ง build ตอบคำถามแบบโต้ตอบไม่ได้ (stdin เป็น `/dev/null`)
- ไม่มีการ rollback อัตโนมัติ ถ้าต้องการย้อนเวอร์ชันให้ Apply ใหม่แล้วเลือก tag เก่า
