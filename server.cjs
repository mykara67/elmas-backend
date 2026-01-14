// server.cjs
// Tek giriş noktası: Render/Node başlangıcında bunu çalıştır.
// Amaç: bot.cjs'i güvenli şekilde başlatmak ve hata olursa loglamak.

console.log('➡️ server.cjs başladı (entrypoint)')

process.on('unhandledRejection', (e) => {
  console.error('❌ unhandledRejection:', e)
})
process.on('uncaughtException', (e) => {
  console.error('❌ uncaughtException:', e)
})

try {
  // bot.cjs içinde migrate + bot.launch zaten yapılıyorsa burada ekstra bir şey yapma
  require('./bot.cjs')
  console.log('✅ bot.cjs require edildi')
} catch (e) {
  console.error('❌ bot.cjs yüklenemedi:', e?.message || e)
  process.exit(1)
}
