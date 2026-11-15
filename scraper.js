const puppeteer = require('puppeteer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const BASE_URL = 'https://saimotv.com';
const OUTPUT_DIR = path.join(__dirname, 'listas');
const FALLBACK_FILMES_URL = 'https://raw.githubusercontent.com/cartoonzine/cartoonzine-sm-bridge/refs/heads/main/filmes_saimo.json';

const ROUTES = {
  canais: [
    '/tv-ao-vivo',
    '/tv-ao-vivo/esportes',
    '/tv-ao-vivo/tv-aberta',
    '/tv-ao-vivo/filmes-e-series',
    '/tv-ao-vivo/noticias',
    '/tv-ao-vivo/infantil',
    '/tv-ao-vivo/documentarios'
  ],
  filmes: ['/filmes'],
  series: ['/series'],
  animes: ['/animes'],
  doramas: ['/doramas']
};

/**
 * Formata qualquer objeto para o schema do seu sistema:
 * { cat, title, desc, thumb, bannerThumb, year, genre, fontes }
 */
function formatToCartoonzineSchema(raw, defaultCat = 'Filmes') {
  if (raw && Array.isArray(raw.fontes) && raw.title !== undefined && raw.thumb !== undefined) {
    return {
      cat: raw.cat || defaultCat,
      title: String(raw.title || '').trim(),
      desc: String(raw.desc || '').trim(),
      thumb: String(raw.thumb || '').trim(),
      bannerThumb: String(raw.bannerThumb || raw.thumb || '').trim(),
      year: String(raw.year || '').trim(),
      genre: String(raw.genre || defaultCat).trim(),
      fontes: raw.fontes
    };
  }

  const title = (
    raw.title || raw.name || raw.nome || raw.titulo || raw.tvg_name || raw.slug || ''
  ).toString().trim();

  let thumb = (
    raw.thumb || raw.poster || raw. posterUrl || raw.poster_path || raw.logo ||
    raw.image || raw.img || raw.capa || raw.tvg_logo || raw.icon || raw.cover || ''
  ).toString().trim();

  if (thumb.startsWith('/') && !thumb.startsWith('//')) {
    thumb = thumb.includes('tmdb') ? `https://image.tmdb.org/t/p/w500${thumb}` : `${BASE_URL}${thumb}`;
  }

  let bannerThumb = (
    raw.bannerThumb || raw.backdrop || raw.backdropUrl || raw.backdrop_path ||
    raw.banner || raw.fanart || raw.background || thumb || ''
  ).toString().trim();

  if (bannerThumb.startsWith('/') && !bannerThumb.startsWith('//')) {
    bannerThumb = bannerThumb.includes('tmdb') ? `https://image.tmdb.org/t/p/original${bannerThumb}` : `${BASE_URL}${bannerThumb}`;
  }

  const desc = (
    raw.desc || raw.description || raw.sinopse || raw.overview || raw.plot || raw.resumo || ''
  ).toString().trim();

  const year = (
    raw.year || raw.ano || raw.release_year ||
    (raw.release_date ? String(raw.release_date).slice(0, 4) : '') ||
    (raw.first_air_date ? String(raw.first_air_date).slice(0, 4) : '') || ''
  ).toString().trim();

  const genre = (
    Array.isArray(raw.genres) ? raw.genres.map(g => g.name || g).join(', ') :
    (raw.genre || raw.genero || raw.category || raw.categoria || raw.group || raw.group_title || defaultCat)
  ).toString().trim();

  const cat = (raw.cat || raw.type || raw.tipo || defaultCat).toString().trim();

  let fontes = [];
  if (Array.isArray(raw.fontes) && raw.fontes.length > 0) {
    fontes = raw.fontes;
  } else if (Array.isArray(raw.sources) && raw.sources.length > 0) {
    fontes = raw.sources;
  } else if (Array.isArray(raw.streams) && raw.streams.length > 0) {
    fontes = raw.streams;
  } else if (Array.isArray(raw.urls) && raw.urls.length > 0) {
    fontes = raw.urls;
  } else if (Array.isArray(raw.episodes) || Array.isArray(raw.episodios) || Array.isArray(raw.seasons)) {
    fontes = raw.episodes || raw.episodios || raw.seasons;
  } else {
    const singleUrl =
      raw.streamUrl || raw.stream_url || raw.stream || raw.m3u8 ||
      raw.videoUrl || raw.video || raw.embedUrl || raw.embed ||
      raw.url || raw.link || raw.src || raw.file || raw.href || '';
    if (singleUrl) {
      fontes = [singleUrl.startsWith('/') ? `${BASE_URL}${singleUrl}` : singleUrl];
    }
  }

  return { cat, title, desc, thumb, bannerThumb, year, genre, fontes };
}

/**
 * Extrai objetos JSON de payloads Next.js RSC (React Server Components) e textos JS
 */
function extractObjectsFromNextPayload(text) {
  const extracted = [];

  // 1. Procura arrays JSON de objetos dentro do payload RSC ou JS
  const regexArray = /\[\s*\{[\s\S]*?\}\s*\]/g;
  let match;
  while ((match = regexArray.exec(text)) !== null) {
    const candidate = match[0];
    if (candidate.length < 40) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed) && parsed.length > 0) {
        for (const item of parsed) {
          if (item && typeof item === 'object' && (item.title || item.name || item.nome || item.titulo || item.slug || item.streamUrl || item.url)) {
            extracted.push(item);
          }
        }
      }
    } catch (_) {
      // Se tiver escape de string do Next.js (__next_f.push), tenta desescapar
      try {
        const unescaped = candidate.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        const parsed = JSON.parse(unescaped);
        if (Array.isArray(parsed)) {
          for (const item of parsed) {
            if (item && typeof item === 'object' && (item.title || item.name || item.nome || item.titulo || item.slug)) {
              extracted.push(item);
            }
          }
        }
      } catch (_) {}
    }
  }

  return extracted;
}

/**
 * Extrai itens de uma rota do saimotv.com (Rede + Next.js Flight Data + Scroll Paginado + DOM)
 */
async function scrapeSaimoRoute(page, routePath, categoryLabel, maxScrolls = 15) {
  const targetUrl = `${BASE_URL}${routePath}`;
  console.log(`\n[Acessando Rota] -> ${targetUrl} (${categoryLabel})`);

  const routeItems = [];

  const onResponse = async (res) => {
    const rUrl = res.url();
    const status = res.status();
    const cType = (res.headers()['content-type'] || '').toLowerCase();

    if (status >= 400) return;
    if (
      rUrl.includes('google-analytics') || rUrl.includes('googletagmanager') ||
      rUrl.includes('bancadeltempoidea') || rUrl.includes('mamshirt') ||
      rUrl.includes('aqml.org') || rUrl.includes('directyp') || rUrl.includes('aarems') ||
      /\.(png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|css)(\?|$)/i.test(rUrl)
    ) {
      return;
    }

    try {
      const text = await res.text();
      if (!text || text.length < 30) return;

      // Se for JSON de API
      if (cType.includes('application/json') || rUrl.includes('/api/')) {
        console.log(`  [API/JSON ${status}] -> ${rUrl} (${text.length} bytes)`);
        try {
          const json = JSON.parse(text);
          const list = Array.isArray(json)
            ? json
            : (json.data || json.items || json.results || json.movies || json.series || json.channels || json.canais || json.filmes || json.animes || json.doramas);
          if (Array.isArray(list) && list.length > 0) {
            console.log(`    -> [+] Capturados ${list.length} itens da API!`);
            routeItems.push(...list);
            return;
          }
        } catch (_) {}
      }

      // Se for payload RSC do Next.js (?_rsc=...) ou HTML/JS do saimotv.com
      if (rUrl.includes('saimotv.com') && (rUrl.includes('_rsc=') || cType.includes('text/x-component') || cType.includes('html') || cType.includes('javascript'))) {
        const objs = extractObjectsFromNextPayload(text);
        if (objs.length > 0) {
          console.log(`  [Next.js Payload] -> ${rUrl} (${objs.length} objetos extraídos)`);
          routeItems.push(...objs);
        }
      }
    } catch (_) {}
  };

  page.on('response', onResponse);

  try {
    await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(r => setTimeout(r, 3000));

    // Faz scroll automático ou clica em "Carregar mais / Próxima" para acionar paginações
    for (let s = 0; s < maxScrolls; s++) {
      const clickedMore = await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
        const btns = Array.from(document.querySelectorAll('button, a'));
        const loadMore = btns.find(b => /carregar mais|ver mais|próxim|mostrar mais/i.test(b.innerText || ''));
        if (loadMore && !loadMore.disabled) {
          loadMore.click();
          return true;
        }
        return false;
      });
      await new Promise(r => setTimeout(r, 1200));
      if (!clickedMore && s > 4) break;
    }

    // Extrai dados do DOM e do self.__next_f da página
    const domAndFlight = await page.evaluate((catLbl) => {
      const results = [];

      // 1. Varre os scripts do Next.js App Router (self.__next_f)
      if (Array.isArray(window.__next_f)) {
        const fullFlightText = window.__next_f.map(chunk => Array.isArray(chunk) ? chunk.join('') : String(chunk)).join('\n');
        results.push({ _rawFlight: fullFlightText });
      }

      // 2. Captura todos os cards de canais / filmes / séries / animes / doramas renderizados no DOM
      const links = Array.from(document.querySelectorAll('a[href]'));
      for (const a of links) {
        const href = a.getAttribute('href') || '';
        if (
          href.startsWith('/canal/') ||
          href.startsWith('/filme/') ||
          href.startsWith('/filmes/') ||
          href.startsWith('/serie/') ||
          href.startsWith('/series/') ||
          href.startsWith('/anime/') ||
          href.startsWith('/animes/') ||
          href.startsWith('/dorama/') ||
          href.startsWith('/doramas/') ||
          href.startsWith('/assistir/') ||
          href.startsWith('/watch/')
        ) {
          const img = a.querySelector('img');
          const lines = (a.innerText || '').split('\n').map(l => l.trim()).filter(Boolean);
          const title = a.getAttribute('title') || img?.getAttribute('alt') || lines[0] || href.split('/').pop();
          const yearMatch = (a.innerText || '').match(/\b(19\d{2}|20\d{2})\b/);
          const thumb = img?.src || img?.getAttribute('data-src') || '';

          results.push({
            cat: catLbl,
            title,
            thumb,
            year: yearMatch ? yearMatch[1] : '',
            genre: catLbl,
            href: href.startsWith('http') ? href : `https://saimotv.com${href}`
          });
        }
      }

      return results;
    }, categoryLabel);

    for (const entry of domAndFlight) {
      if (entry._rawFlight) {
        const fromFlight = extractObjectsFromNextPayload(entry._rawFlight);
        if (fromFlight.length > 0) {
          console.log(`  [Next.js __next_f] -> ${fromFlight.length} objetos extraídos da memória`);
          routeItems.push(...fromFlight);
        }
      } else {
        routeItems.push(entry);
      }
    }

  } catch (err) {
    console.warn(`  [Aviso] Erro na rota ${targetUrl}:`, err.message);
  } finally {
    page.off('response', onResponse);
  }

  return routeItems;
}

/**
 * Para os canais de TV (/canal/sportv, etc.), entra nos canais para capturar o link .m3u8 real
 * ou o link do proxy https://play.saimotv.com/api/proxy?url=...
 */
async function resolveChannelStreams(page, channels) {
  console.log(`\n[Resolvendo Streams M3U8 de ${channels.length} Canais...]`);
  const resolved = [];

  for (let i = 0; i < channels.length; i++) {
    const ch = channels[i];
    const channelUrl = (ch.fontes && ch.fontes[0]) || ch.href || '';

    // Se já tem link .m3u8 direto, mantém
    if (!channelUrl.includes('saimotv.com/canal/')) {
      resolved.push(ch);
      continue;
    }

    const capturedStreams = [];
    const onStreamRes = (req) => {
      const u = req.url();
      if (u.includes('.m3u8') || u.includes('play.saimotv.com/api/proxy')) {
        if (!u.includes('error.txt')) capturedStreams.push(u);
      }
    };

    page.on('request', onStreamRes);
    try {
      await page.goto(channelUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await new Promise(r => setTimeout(r, 2500));

      // Também procura URLs .m3u8 dentro do HTML/RSC do canal
      const htmlStreams = await page.evaluate(() => {
        const html = document.documentElement.innerHTML;
        const matches = html.match(/https?:\/\/[^"'\\\s]+\.m3u8[^"'\\\s]*/g) || [];
        return matches;
      });

      const allStreams = [...new Set([...capturedStreams, ...htmlStreams])];
      if (allStreams.length > 0) {
        ch.fontes = allStreams;
        console.log(`  [Stream OK] ${ch.title} -> ${allStreams[0].slice(0, 80)}...`);
      }
    } catch (_) {
    } finally {
      page.off('request', onStreamRes);
    }

    resolved.push(ch);
  }

  return resolved;
}

function deduplicate(items) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    if (!it.title || it.title.length < 2) continue;
    const key = `${it.title.toLowerCase()}|${it.cat}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(it);
    }
  }
  return out;
}

function saveJsonFile(filename, items) {
  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }
  const fullPath = path.join(OUTPUT_DIR, filename);
  fs.writeFileSync(fullPath, JSON.stringify(items, null, 2), 'utf-8');
  console.log(`  [✓] Arquivo listas/${filename} salvo com ${items.length.toLocaleString('pt-BR')} registros.`);
}

function saveSeriesIn3Parts(seriesArray) {
  const total = seriesArray.length;
  const partSize = Math.ceil(total / 3) || 0;
  saveJsonFile('series_sm_pt1.json', seriesArray.slice(0, partSize));
  saveJsonFile('series_sm_pt2.json', seriesArray.slice(partSize, partSize * 2));
  saveJsonFile('series_sm_pt3.json', seriesArray.slice(partSize * 2));
}

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR,pt;q=0.9' });

    // Bloqueia scripts de propaganda agressivos (bancadeltempoidea, mamshirt, etc.) para acelerar 10x o scraper
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const u = req.url();
      if (
        u.includes('bancadeltempoidea') || u.includes('mamshirt') ||
        u.includes('aqml.org') || u.includes('directyp') || u.includes('aarems') ||
        u.includes('nresystems') || u.includes('google-analytics')
      ) {
        return req.abort();
      }
      req.continue();
    });

    // 1. CANAIS (TV AO VIVO)
    let rawCanais = [];
    for (const r of ROUTES.canais) {
      const items = await scrapeSaimoRoute(page, r, 'Canais', 5);
      rawCanais.push(...items);
    }
    let formattedCanais = deduplicate(rawCanais.map(it => formatToCartoonzineSchema(it, 'Canais')));
    formattedCanais = await resolveChannelStreams(page, formattedCanais);
    saveJsonFile('canais_sm.json', formattedCanais);

    // 2. FILMES
    const rawFilmes = await scrapeSaimoRoute(page, '/filmes', 'Filmes', 20);
    let formattedFilmes = deduplicate(rawFilmes.map(it => formatToCartoonzineSchema(it, 'Filmes')));

    // Complementa com o catálogo de referência caso a página entregue apenas os primeiros lotes paginados
    if (formattedFilmes.length < 1000) {
      try {
        const { data } = await axios.get(FALLBACK_FILMES_URL, { timeout: 30000 });
        if (Array.isArray(data)) {
          console.log(`  [+] Mesclando ${data.length} filmes da base principal com os novos do saimotv.com`);
          const fallbackFormatted = data.map(it => formatToCartoonzineSchema(it, 'Filmes'));
          formattedFilmes = deduplicate([...formattedFilmes, ...fallbackFormatted]);
        }
      } catch (_) {}
    }
    saveJsonFile('filmes_sm.json', formattedFilmes);

    // 3. SÉRIES (Divididas em 3 partes)
    const rawSeries = await scrapeSaimoRoute(page, '/series', 'Séries', 20);
    const formattedSeries = deduplicate(rawSeries.map(it => formatToCartoonzineSchema(it, 'Séries')));
    saveSeriesIn3Parts(formattedSeries);

    // 4. ANIMES
    const rawAnimes = await scrapeSaimoRoute(page, '/animes', 'Animes', 15);
    const formattedAnimes = deduplicate(rawAnimes.map(it => formatToCartoonzineSchema(it, 'Animes')));
    saveJsonFile('animes_sm.json', formattedAnimes);

    // 5. DORAMAS
    const rawDoramas = await scrapeSaimoRoute(page, '/doramas', 'Doramas', 15);
    const formattedDoramas = deduplicate(rawDoramas.map(it => formatToCartoonzineSchema(it, 'Doramas')));
    saveJsonFile('doramas_sm.json', formattedDoramas);

    await page.close();
  } catch (err) {
    console.error('[Erro Fatal]:', err);
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
