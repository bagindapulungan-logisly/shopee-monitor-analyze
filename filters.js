// Shared filtering lists for keyword mining

const STOPWORDS = new Set([
  'yang', 'dan', 'atau', 'di', 'ke', 'dari', 'untuk', 'pada', 'dengan', 'ini', 'itu',
  'ya', 'iya', 'ok', 'oke', 'nah', 'deh', 'dong', 'nih', 'lah', 'sih', 'kok', 'pun',
  'sudah', 'udah', 'belum', 'lagi', 'masih', 'bisa', 'tidak', 'ga', 'gak', 'nggak',
  'ngga', 'nya', 'saya', 'kami', 'kita', 'aku', 'anda', 'kamu', 'dia', 'mereka',
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'to', 'of', 'in', 'for', 'on', 'at',
  'please', 'pls', 'plz', 'tolong', 'mohon', 'pak', 'bu', 'sir', 'maam'
]);

const BLOCKLIST_TOKENS = new Set([
  'cdd', 'tronton', 'truk', 'truck', 'pickup', 'pick', 'van', 'wingbox', 'wing',
  'box', 'engkel', 'fuso', 'colt', 'dump', 'trailer', 'head', 'headtruck',
  '4wh', '6wh', '8wh', '10wh', '12wh', 'spx', 'hp', 'first', 'mile', 'hub', 'cp',
  'adhoc', 'dc', 'tiba', 'long', 'jam', 'ada', 'no', 'transit', 'sko', 'shopee',
  'logisly', 'id', 'dd', 'cddl','ata','eta','tlp','kosambi','terima', 'sunter', 'soc', 'sempat', 'neglasari',
  'terimakasih', 'bandung', 'jakarta', 'bekasi', 'depok', 'tangerang', 'bogor',
  'surabaya', 'semarang', 'yogyakarta', 'solo', 'malang', 'cirebon', 'purwakarta',
  'karawang', 'subang', 'indramayu', 'garut', 'tasikmalaya', 'ciamis', 'banjar',
  'pangandaran', 'cianjur', 'sukabumi', 'lembang', 'padalarang', 'cisauk',
  'serpong', 'bintaro', 'ciputat', 'pamulang', 'cilandak', 'cilandak', 'do', 'tersebut', 'vm','spxid',
  'virtual', 'logos', 'maaf', 'wua', 'cirebon', 'tuan'
]);

const BLOCKLIST_PHRASES = new Set([
  'dc logisly', 'hub logisly', 'gudang logisly', 'logisly hub', 'first mile',
  'mile hub', 'first mile hub', 'no hp', 'id spx', 'transit point', 'muat tamalanrea',
  'terima kasih', 'logisly driver', 'vendor logisly driver',
  'spxid vm', 'do shopee', 'tujuan kalawat', 'point neglasari', 'transit point neglasari',
  'rest area', 'point logos', 'transit point logos'



]);

module.exports = {
  STOPWORDS,
  BLOCKLIST_TOKENS,
  BLOCKLIST_PHRASES
};
