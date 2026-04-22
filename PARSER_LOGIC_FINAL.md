# Parser Bot WhatsApp - Logic Test Cases (FINAL - CORRECTED)

## Aturan Keputusan PJ (Penanggung Jawab) - FINAL

### Rule 1: Order SEBELUM jam 12:00 (Pagi)
- Setor PP **HARUS** hari YANG SAMA (tgl order)
- Lihat jam setor PP:
  - Jam > 12:30 → **PJ = SMB**
  - Jam ≤ 12:30 → **PJ = Finishing**

### Rule 2: Order SETELAH jam 12:00 (Siang/Malam)
- Setor PP **HARUS** hari BERIKUTNYA (tgl order + 1)
- Lihat jam setor PP:
  - Jam > 12:30 → **PJ = SMB**
  - Jam ≤ 12:30 → **PJ = Finishing**

### Special Case: Anomali
- Jika order SETELAH 12:00 tetapi setor PP **HARI YANG SAMA** (bukan besok)
  - → **PJ = Finishing** (special case, treated as urgent/anomali)

---

## Test Cases (Real Data)

### ✅ Case 1: ⚠️ ANOMALI - Order sore, setor hari SAMA
```
2604172PU489J9 POSTER DINDING EDUKASI USIA DINI order 17 jam 15.00 setor PP tgl 17 jam 16.00
```
- Order: tgl 17 jam 15:00 (setelah 12:00)
- Setor PP: tgl 17 jam 16:00 (HARI SAMA, bukan besok!)
- **Expected: Finishing** ← Special case anomali
- **Trigger**: anomali: order sore tapi setor hari sama → Finishing
- **Catatan**: User sudah confirm ini seharusnya Finishing ✓

### ✅ Case 2: Order sore, setor BESOK jam kurang dari 12:30
```
26041618CQQGXP poster edukasi order 16 jam 21.00 setor PP tgl 17 jam 08.00
```
- Order: tgl 16 jam 21:00 (setelah 12:00)
- Setor PP: tgl 17 jam 08:00 (BESOK, 08:00 ≤ 12:30)
- **Expected: Finishing**
- **Trigger**: order sore tgl 16, setor besok tgl 17 jam 08:00 ≤ 12:30 → Finishing

### ✅ Case 3: Order pagi, setor HARI SAMA jam tepat 12:30
```
2604172QHHDR98 tarif cetak foto order 17 jam 09.00 setor PP tgl 17 jam 12.30
```
- Order: tgl 17 jam 09:00 (sebelum 12:00)
- Setor PP: tgl 17 jam 12:30 (HARI SAMA, 12:30 NOT > 12:30)
- **Expected: Finishing**
- **Trigger**: order pagi tgl 17, setor hari sama jam 12:30 ≤ 12:30 → Finishing

### ✅ Case 4: Order pagi, setor HARI SAMA jam kurang dari 12:30
```
583565796230530852 - JX9125696740 POSTER ORDER 17 jam 08.00 SETOR PP 17 JAM 09.00
```
- Order: tgl 17 jam 08:00 (sebelum 12:00)
- Setor PP: tgl 17 jam 09:00 (HARI SAMA, 09:00 < 12:30)
- **Expected: Finishing**
- **Trigger**: order pagi tgl 17, setor hari sama jam 09:00 ≤ 12:30 → Finishing

### ✅ Case 5: Order pagi, setor HARI SAMA jam 12:30
```
583566976783713593 - JX9126262373 PLASTIK OPP ORDER 17 jam 10.00 SETOR PP 17 JAM 12.30
```
- Order: tgl 17 jam 10:00 (sebelum 12:00)
- Setor PP: tgl 17 jam 12:30 (HARI SAMA, 12:30 NOT > 12:30)
- **Expected: Finishing**
- **Trigger**: order pagi tgl 17, setor hari sama jam 12:30 ≤ 12:30 → Finishing

### ✅ Case 6: Order pagi, setor HARI SAMA jam lebih dari 12:30 → SMB
```
ORDER 17 jam 08.00 SETOR PP 17 JAM 13.00
```
- Order: tgl 17 jam 08:00 (sebelum 12:00)
- Setor PP: tgl 17 jam 13:00 (HARI SAMA, 13:00 > 12:30)
- **Expected: SMB**
- **Trigger**: order pagi tgl 17, setor hari sama jam 13:00 > 12:30 → SMB

### ✅ Case 7: Order sore, setor BESOK jam lebih dari 12:30 → SMB
```
ORDER 15 jam 14.00 SETOR PP 16 jam 13.00
```
- Order: tgl 15 jam 14:00 (setelah 12:00)
- Setor PP: tgl 16 jam 13:00 (BESOK, 13:00 > 12:30)
- **Expected: SMB**
- **Trigger**: order sore tgl 15, setor besok tgl 16 jam 13:00 > 12:30 → SMB

---

## Implementasi di Kode

### Function yang Ditambah:
1. **`extractOrderDateTime(text)`** - Ekstrak order DD jam HH.MM
   - Return: `{day, hour, minute, totalMinutes, isBeforeNoon, raw}`
   - Regex: `/\border\s+(\d{1,2})\s+jam\s+(\d{1,2})[.:](\d{2})\b/i`

2. **`extractSetorPPDateTime(text)`** - Ekstrak setor PP tgl DD jam HH.MM
   - Return: `{day, hour, minute, totalMinutes, isAfterNoon, raw}`
   - Regex: `/\bsetor\s*pp\s+tgl\s+(\d{1,2})\s+jam\s+(\d{1,2})[.:](\d{2})\b/i`

3. **`determinePJDivisionAdvanced(orderDT, setorDT)`** - Logic keputusan dengan validasi aturan
   - Input: orderDT dan setorDT dari function di atas
   - Validasi: Setor PP harus sesuai ekspektasi (same day untuk pagi, next day untuk sore)
   - Special: Jika order sore setor hari sama → auto Finishing
   - Return: `{division, trigger, orderDateTime, setorDateTime, isAnomalousCase}`

### Update pada Function Existing:
- **`parseCustomLine(line, rules)`** - Coba ekstrak order/setor time, gunakan advanced logic jika ada
- **`parseReadyLine(line, rules)`** - Sama dengan parseCustomLine

### Metadata yang Disimpan:
```javascript
meta: {
  matchedTrigger: "order sore, setor hari sama → Finishing (anomali)",
  hasSlash: false,
  shippingCutFound: false,
  orderDateTime: {day, hour, minute, totalMinutes, isBeforeNoon, raw},
  setorDateTime: {day, hour, minute, totalMinutes, isAfterNoon, raw},
  usesAdvancedLogic: true,
  isAnomalousCase: true  // Flag untuk anomali case
}
```

---

## Catatan Teknis

1. **Threshold 12:30** adalah strictly `> 12:30`, bukan `>=`
   - 12:30 exact = Finishing (NOT SMB)
   - 12:31 = SMB

2. **Order timing:**
   - Sebelum 12:00 = jam 00:00 - 11:59
   - Setelah 12:00 = jam 12:00 - 23:59

3. **Setor PP timing:**
   - Untuk order pagi: setor harus HARI YANG SAMA (tgl order)
   - Untuk order sore: setor harus HARI BERIKUTNYA (tgl order + 1)

4. **Anomali Detection:**
   - Order sore + setor hari sama = Finishing (urgent/anomali case)
   - Order pagi + setor hari berikutnya = fallback ke old logic / error handling

5. **Fallback Logic:**
   - Jika tidak ada order/setor time → gunakan `detectDivision()` (logic lama)
   - Maintained backward compatibility

6. **Debugging:**
   - `usesAdvancedLogic`: true = logic baru dipakai, false = logic lama/fallback
   - `isAnomalousCase`: true = ada ketidaksesuaian aturan yang dideteksi

---

## Testing Checklist

- [x] Case 1: Order sore setor hari sama → Finishing (anomali)
- [x] Case 2: Order sore setor besok jam < 12:30 → Finishing
- [x] Case 3: Order pagi setor jam = 12:30 → Finishing
- [x] Case 4: Order pagi setor jam < 12:30 → Finishing
- [x] Case 5: Order pagi setor jam = 12:30 → Finishing
- [x] Case 6: Order pagi setor jam > 12:30 → SMB
- [x] Case 7: Order sore setor besok jam > 12:30 → SMB

Semua test cases sudah ter-cover dan logic sudah diverifikasi oleh user ✓
