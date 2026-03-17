const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3001;

function fetchUrl(url, options = {}) {
  return new Promise((resolve, reject) => {
    const { method = 'GET', headers = {}, body = null } = options;
    const urlObj = new URL(url);
    const reqOptions = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        ...headers
      }
    };
    const req = https.request(reqOptions, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, options).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, text: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getTranscript(videoId, lang = 'ru') {
  // Шаг 1: Загружаем HTML страницу видео
  const pageUrl = `https://www.youtube.com/watch?v=${videoId}&hl=ru`;
  const { text: html, status } = await fetchUrl(pageUrl);
  
  if (status !== 200) throw new Error(`YouTube page status: ${status}`);
  
  // Шаг 2: Извлекаем ytInitialPlayerResponse из HTML
  let playerMatch = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});(?:var |<\/script>)/s);
  if (!playerMatch) {
    playerMatch = html.match(/ytInitialPlayerResponse\s*=\s*(\{[\s\S]+?\});\s*(?:var |if |<)/);
    if (!playerMatch) throw new Error('ytInitialPlayerResponse not found in page');
  }
  
  let playerData;
  try {
    playerData = JSON.parse(playerMatch[1]);
  } catch(e) {
    throw new Error('Failed to parse ytInitialPlayerResponse: ' + e.message);
  }
  
  // Шаг 3: Название и канал
  const title   = playerData?.videoDetails?.title  || null;
  const channel = playerData?.videoDetails?.author || null;
  
  // Шаг 4: Находим субтитры
  console.log('[Debug] videoDetails:', JSON.stringify(playerData?.videoDetails?.title));
  console.log('[Debug] captions keys:', JSON.stringify(Object.keys(playerData?.captions || {})));
  console.log('[Debug] tracks:', JSON.stringify(playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.map(t => t.languageCode)));
  
  const tracks = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!tracks || tracks.length === 0) {
    // Проверяем есть ли автосубтитры
    const autoTracks = playerData?.captions?.playerCaptionsTracklistRenderer?.translationLanguages;
    console.log('[Debug] translationLanguages count:', autoTracks?.length);
    throw new Error('No captions available for this video');
  }
  
  // Выбираем язык: ru → en → первый доступный
  const track = tracks.find(t => t.languageCode === lang)
    || tracks.find(t => t.languageCode === 'en')
    || tracks[0];
  
  const captionUrl = track.baseUrl;
  
  // Шаг 5: Скачиваем XML субтитров
  const { text: xml } = await fetchUrl(captionUrl);
  
  // Шаг 6: Парсим XML
  const snippets = [];
  const regex = /<text start="([^"]+)" dur="([^"]+)"[^>]*>([\s\S]*?)<\/text>/g;
  let match;
  while ((match = regex.exec(xml)) !== null) {
    const start = parseFloat(match[1]);
    const dur   = parseFloat(match[2]);
    const text  = match[3]
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g,  '&')
      .replace(/&lt;/g,   '<')
      .replace(/&gt;/g,   '>')
      .replace(/&#39;/g,  "'")
      .replace(/&quot;/g, '"')
      .replace(/\n/g, ' ')
      .trim();
    if (text) snippets.push({ text, start, end: start + dur });
  }
  
  if (snippets.length === 0) throw new Error('Parsed 0 snippets from XML');
  
  return { title, channel, language: track.languageCode, snippets };
}
 
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');
  
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  
  const url = new URL(req.url, `http://localhost:${PORT}`);
  
  if (url.pathname === '/') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', message: 'Transcript proxy running' }));
    return;
  }
  
  if (url.pathname !== '/api/transcript') {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
    return;
  }
  
  const videoId = url.searchParams.get('v');
  const lang    = url.searchParams.get('lang') || 'ru';
  
  if (!videoId) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: 'Missing ?v=VIDEO_ID' }));
    return;
  }
  
  try {
    const result = await getTranscript(videoId, lang);
    res.writeHead(200);
    res.end(JSON.stringify(result));
  } catch(e) {
    console.error('[Proxy Error]', e.message);
    res.writeHead(500);
    res.end(JSON.stringify({ error: e.message }));
  }
});

server.listen(PORT, () => console.log(`Transcript proxy running on :${PORT}`));
