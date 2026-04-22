# Parser Bot WhatsApp - Logic Test Cases

## Logic Keputusan PJ (Penanggung Jawab)

### Rule:
1. **Order SEBELUM jam 12:00 (pagi)**
   - Setor PP > 12:30 → **PJ = SMB**
   - Setor PP ≤ 12:30 → **PJ = Finishing**

2. **Order SETELAH jam 12:00 (siang/malam)**
   - Setor PP hari BERIKUTNYA > 12:30 → **PJ = SMB**
   - Setor PP hari BERIKUTNYA ≤ 12:30 → **PJ = Finishing**
   - Setor PP hari SAMA > 12:30 → **PJ = SMB**
   - Setor PP hari SAMA ≤ 12:30 → **PJ = Finishing**

---

## Test Cases dari Real Data

### Case 1: Order sore, setor PP hari sama LEBIH dari 12:30
```
2604172PU489J9 POSTER DINDING EDUKASI USIA DINI order 17 jam 15.00 setor PP tgl 17 jam 16.00
```
- Order: tgl 17 jam 15:00 (setelah 12:00)
- Setor PP: tgl 17 jam 16:00 (sama hari, 16:00 > 12:30)
- **Expected: SMB**
- **Trigger**: order sore, setor hari ini 16:00 > 12:30

### Case 2: Order malam, setor PP hari BERIKUTNYA KURANG dari 12:30
```
26041618CQQGXP poster edukasi order 16 jam 21.00 setor PP tgl 17 jam 08.00
```
- Order: tgl 16 jam 21:00 (setelah 12:00)
- Setor PP: tgl 17 jam 08:00 (hari berikutnya, 08:00 < 12:30)
- **Expected: Finishing**
- **Trigger**: order sore, setor besok 08:00 ≤ 12:30

### Case 3: Order pagi, setor PP KURANG dari 12:30
```
2604172QHHDR98 tarif cetak foto order 17 jam 09.00 setor PP tgl 17 jam 12.30
```
- Order: tgl 17 jam 09:00 (sebelum 12:00)
- Setor PP: tgl 17 jam 12:30 (12:30 = 12:30, not >)
- **Expected: Finishing**
- **Trigger**: order pagi, setor 12:30 ≤ 12:30

### Case 4: Order pagi, setor PP LEBIH dari 12:30 (beda format)
```
583565796230530852 - JX9125696740 POSTER ORDER 17 jam 08.00 SETOR PP 17 JAM 09.00
```
- Order: tgl 17 jam 08:00 (sebelum 12:00)
- Setor PP: tgl 17 jam 09:00 (09:00 < 12:30)
- **Expected: Finishing**
- **Trigger**: order pagi, setor 09:00 ≤ 12:30

### Case 5: Order pagi, setor PP LEBIH dari 12:30
```
583566976783713593 - JX9126262373 PLASTIK OPP ORDER 17 jam 10.00 SETOR PP 17 JAM 12.30
```
- Order: tgl 17 jam 10:00 (sebelum 12:00)
- Setor PP: tgl 17 jam 12:30 (12:30 = not >)
- **Expected: Finishing**
- **Trigger**: order pagi, setor 12:30 ≤ 12:30

---

## Implementasi di Kode

### Function yang Ditambah:
1. **`extractOrderDateTime(text)`** - Ekstrak order DD jam HH.MM
   - Return: `{day, hour, minute, totalMinutes, isBeforeNoon, raw}`
   - Regex: `/\border\s+(\d{1,2})\s+jam\s+(\d{1,2})[.:](\d{2})\b/i`

2. **`extractSetorPPDateTime(text)`** - Ekstrak setor PP tgl DD jam HH.MM
   - Return: `{day, hour, minute, totalMinutes, isAfterNoon, raw}`
   - Regex: `/\bsetor\s*pp\s+tgl\s+(\d{1,2})\s+jam\s+(\d{1,2})[.:](\d{2})\b/i`

3. **`determinePJDivisionAdvanced(orderDT, setorDT)`** - Logic keputusan kompleks
   - Input: orderDT dan setorDT dari function di atas
   - Return: `{division, trigger, orderDateTime, setorDateTime}`

### Update pada Function Existing:
- **`parseCustomLine(line, rules)`** - Coba ekstrak order/setor time, gunakan advanced logic jika ada
- **`parseReadyLine(line, rules)`** - Sama dengan parseCustomLine

### Metadata yang Disimpan:
```javascript
meta: {
  matchedTrigger: "...",
  hasSlash: false,
  shippingCutFound: false,
  orderDateTime: {day, hour, minute, totalMinutes, isBeforeNoon, raw},
  setorDateTime: {day, hour, minute, totalMinutes, isAfterNoon, raw},
  usesAdvancedLogic: true  // Flag untuk tahu apakah pakai advanced logic atau standar
}
```

---

## Catatan Teknis

1. Threshold untuk "lebih dari 12:30" adalah **stricty** `> 12:30` (760 menit)
2. Ekstraksi ambil dari pesan mentah, case-insensitive
3. Fallback ke `detectDivision()` (logic lama) jika tidak ada order/setor time
4. Metadata membantu debugging untuk tahu logic mana yang dipakai

