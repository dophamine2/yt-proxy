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
        'User-Agent': 'com.google.android.youtube/17.31.35 (Linux; U; Android 11) gzip',
        'Content-Type': 'application/json',
        'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.8',
        'X-YouTube-Client-Name': '3',
        'X-YouTube-Client-Version': '17.31.35',
        ...headers
      }
    };
    const req = https.request(reqOptions, (res) => {
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
  // Innertube API без ключа — Android client
  const playerBody = JSON.stringify({
    context: {
      client: {
        clientName: 'ANDROID',
        clientVersion: '17.31.35',
        androidSdkVersion: 30,
        hl: 'ru',
        gl: 'RU',
        utcOffsetMinutes: 180
      }
    },
    videoId
  });

  const { text: playerJson, status } = await fetchUrl(
    'https://www.youtube.com/youtubei/v1/player',
    { method: 'POST', body: playerBody }
  );

  if (status !== 200) throw new Error('YouTube player API status: ' + status);

  let playerData;
  try {
    playerData = JSON.parse(playerJson);
  } catch(e) {
    throw new Error('Failed to parse player response');
  }

  // Название и канал
  const title   = playerData?.videoDetails?.title   || null;
  const channel = playerData?.videoDetails?.author  || null;

  // Субтитры
  const tracks = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!tracks || tracks.length === 0) {
    throw new Error('No captions available for this video');
  }

  // Выбираем язык: ru → en → первый доступный
  const track = tracks.find(t => t.languageCode === lang)
    || tracks.find(t => t.languageCode === 'en')
    || tracks[0];

  const baseUrl = track.baseUrl.replace(/&fmt=\w+$/, '');

  // Скачиваем XML субтитров
  const { text: xml } = await fetchUrl(baseUrl);

  // Парсим XML
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