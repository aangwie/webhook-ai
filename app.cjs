// Pintu masuk untuk hosting berbasis Phusion Passenger (cPanel "Setup Node.js App").
// Passenger memuat startup file dengan require(), sedangkan src/server.js adalah ESM
// dengan top-level await yang tidak bisa di-require() — jadi diteruskan lewat import().
import('./src/server.js').catch((error) => {
  console.error(error);
  process.exit(1);
});