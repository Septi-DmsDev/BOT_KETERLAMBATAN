const test_cases = [
  {
    name: 'Case 1: Order sore jam 15.00, setor HARI SAMA jam 16.00 (ANOMALI)',
    message: '2604172PU489J9 POSTER DINDING EDUKASI USIA DINI order 17 jam 15.00 setor PP tgl 17 jam 16.00',
    expectedPJ: 'Finishing',
    expectedTrigger: 'anomali: order sore tapi setor hari sama',
    notes: 'Order setelah 12:00 → setor harus BESOK, ini setor hari sama → FINISHING (special case)'
  },
  {
    name: 'Case 2: Order malam jam 21.00, setor besok jam 08.00',
    message: '26041618CQQGXP poster edukasi order 16 jam 21.00 setor PP tgl 17 jam 08.00',
    expectedPJ: 'Finishing',
    expectedTrigger: 'order sore tgl 16, setor besok tgl 17 jam 08:00 ≤ 12:30 → Finishing',
    notes: 'Order setelah 12:00, setor besok jam < 12:30 → Finishing ✓'
  },
  {
    name: 'Case 3: Order pagi jam 09.00, setor HARI SAMA jam 12.30',
    message: '2604172QHHDR98 tarif cetak foto order 17 jam 09.00 setor PP tgl 17 jam 12.30',
    expectedPJ: 'Finishing',
    expectedTrigger: 'order pagi tgl 17, setor hari sama jam 12:30 ≤ 12:30 → Finishing',
    notes: 'Order sebelum 12:00, setor hari sama jam ≤ 12:30 → Finishing ✓'
  },
  {
    name: 'Case 4: Order pagi jam 08.00, setor HARI SAMA jam 09.00',
    message: '583565796230530852 - JX9125696740 POSTER ORDER 17 jam 08.00 SETOR PP 17 JAM 09.00',
    expectedPJ: 'Finishing',
    expectedTrigger: 'order pagi tgl 17, setor hari sama jam 09:00 ≤ 12:30 → Finishing',
    notes: 'Order sebelum 12:00, setor hari sama jam < 12:30 → Finishing ✓'
  },
  {
    name: 'Case 5: Order pagi jam 10.00, setor HARI SAMA jam 12.30',
    message: '583566976783713593 - JX9126262373 PLASTIK OPP ORDER 17 jam 10.00 SETOR PP 17 JAM 12.30',
    expectedPJ: 'Finishing',
    expectedTrigger: 'order pagi tgl 17, setor hari sama jam 12:30 ≤ 12:30 → Finishing',
    notes: 'Order sebelum 12:00, setor hari sama jam ≤ 12:30 → Finishing ✓'
  },
  {
    name: 'Case 6: Order pagi jam 08.00, setor HARI SAMA jam 13.00 (SMB)',
    message: '583566976783713593 - JX9126262373 PLASTIK OPP ORDER 17 jam 08.00 SETOR PP 17 JAM 13.00',
    expectedPJ: 'SMB',
    expectedTrigger: 'order pagi tgl 17, setor hari sama jam 13:00 > 12:30 → SMB',
    notes: 'Order sebelum 12:00, setor hari sama jam > 12:30 → SMB ✓'
  },
  {
    name: 'Case 7: Order sore jam 14.00, setor BESOK jam 13.00 (SMB)',
    message: 'ORDER 15 jam 14.00 SETOR PP 16 jam 13.00',
    expectedPJ: 'SMB',
    expectedTrigger: 'order sore tgl 15, setor besok tgl 16 jam 13:00 > 12:30 → SMB',
    notes: 'Order setelah 12:00, setor besok jam > 12:30 → SMB ✓'
  }
];

// Log test cases dengan format yang jelas
console.log('='.repeat(100));
console.log('TEST CASES UNTUK PARSER BOT WHATSAPP - LOGIKA KEPUTUSAN PJ (FINAL)');
console.log('='.repeat(100));
console.log('');
console.log('ATURAN:');
console.log('  ├─ Order SEBELUM 12:00 → Setor HARUS hari SAMA');
console.log('  │  ├─ Jam > 12:30 → SMB');
console.log('  │  └─ Jam ≤ 12:30 → Finishing');
console.log('  └─ Order SETELAH 12:00 → Setor HARUS hari BESOK');
console.log('     ├─ Jam > 12:30 → SMB');
console.log('     ├─ Jam ≤ 12:30 → Finishing');
console.log('     └─ Special: Jika setor hari SAMA → Finishing (anomali)');
console.log('');
console.log('='.repeat(100));
console.log('');

test_cases.forEach((tc, i) => {
  console.log(`TEST ${i + 1}: ${tc.name}`);
  console.log('-'.repeat(100));
  console.log(`Message: ${tc.message}`);
  console.log(`Expected PJ: ${tc.expectedPJ}`);
  console.log(`Expected Trigger: ${tc.expectedTrigger}`);
  console.log(`Notes: ${tc.notes}`);
  console.log('');
});

console.log('='.repeat(100));
console.log('UNTUK MENJALANKAN TEST:');
console.log('1. Buka file index.js di bot WhatsApp');
console.log('2. Jalankan bot dengan test message di atas');
console.log('3. Verifikasi bahwa PJ_Divisi dan trigger yang dihasilkan sesuai');
console.log('='.repeat(100));

