import webpush from 'web-push';

const vapidKeys = webpush.generateVAPIDKeys();

console.log('\n=== VAPID KEYS GENERATED ===');
console.log('Simpan kedua key ini ke file .env kamu\n');
console.log('VAPID_PUBLIC_KEY=' + vapidKeys.publicKey);
console.log('VAPID_PRIVATE_KEY=' + vapidKeys.privateKey);
console.log('\n=============================\n');
console.log('Public key juga perlu kamu salin ke file frontend/app.js (variable VAPID_PUBLIC_KEY)\n');
