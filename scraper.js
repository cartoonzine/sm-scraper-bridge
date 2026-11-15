const puppeteer = require('puppeteer');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const URL_CANAIS = 'https://canais-saimo.pages.dev/';
const URL_VOD = 'https://filmes-saimo.pages.dev/';

// Caso você já tenha as listas ou espelhos no seu cartoonzine-sm-bridge, usamos como fallback anti-bloqueio de IP dos EUA
const FALLBACK_FILMES_URL = 'https://raw.githubusercontent.com/cartoonzine/cartoonzine-sm-bridge/refs/heads/main/filmes_saimo.json';

/**
 * Formata qualquer objeto para o padrão exato do seu sistema:
 * { cat, title, desc, thumb, bannerThumb, year, genre, fontes }
 */
function formatToCartoonzineSchema(raw, defaultCat = 'Filmes') {
  // Se já estiver exatamente no formato Cartoonzine, apenas garante a categoria
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
    raw.title || raw.name || raw.nome || raw.titulo || raw.tvg_name || ''
  ).toString().trim();

  const thumb = (
    raw.thumb || raw.poster || raw.logo || raw.image || raw.img || raw.capa ||
    raw.tvg_logo || raw.icon || raw.cover || raw.poster_path || ''
  ).toString().trim();

  const bannerThumb = (
    raw.bannerThumb || raw.backdrop || raw.banner || raw.fanart ||
    raw.backdrop_path || raw.background || thumb || ''
  ).toString().trim();

  const desc = (
    raw.desc || raw.description || raw.sinopse || raw.overview ||
    raw.plot || raw.resumo || ''
  ).toString().trim();

  const year = (
    raw.year || raw.ano || raw.release_year ||
    (raw.release_date ? String(raw.release_date).slice(0, 4) : '') || ''
  ).toString().trim();

  const genre = (
    raw.genre || raw.genero || raw.category || raw.categoria ||
    raw.group || raw.group_title || defaultCat
  ).toString().trim();

  const cat = (
    raw.cat || raw.type || raw.tipo || defaultCat
  ).toString().trim();

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
      raw.url || raw.stream || raw.stream_url || raw.link ||
      raw.src || raw.file || raw.m3u8 || raw.video || raw.play || '';
    if (singleUrl) {
      fontes = [singleUrl];
    }
  }

  return {
    cat,
    title,
    desc,
    thumb,
    bannerThumb,
    year,
    genre,
    fontes
  };
}

/**
 * Parser M3U / TXT
 */
function parseM3U(content, defaultCat = 'Canais') {
  const lines = content.split(/\r?\n/);
  const items = [];
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF:')) {
      const logoMatch = line.match(/tvg-logo="([^"]*)"/i);
      const groupMatch = line.match(/group-title="([^"]*)"/i);
      const commaIdx = line.lastIndexOf(',');
      const title = commaIdx !== -1 ? line.slice(commaIdx + 1).trim() : 'Sem Título';
      const group = groupMatch ? groupMatch[1].trim() : defaultCat;

      current = {
        cat: defaultCat,
        title,
        desc: '',
        thumb: logoMatch ? logoMatch[1].trim() : '',
        bannerThumb: logoMatch ? logoMatch[1].trim() : '',
        year: '',
        genre: group,
        fontes: []
      };
    } else if (!line.startsWith('#') && current) {
      current.fontes = [line];
      items.push(current);
      current = null;
    }
  }
  return items;
}

/**
 * Extrai arrays literais de dentro de bundles JS
 */
function extractJsLiteralArrays(jsCode, sourceUrl) {
  const results = [];

  if (jsCode.includes('#EXTINF:')) {
    const m3u = parseM3U(jsCode);
    if (m3u.length > 0) {
      console.log(`    -> [+] M3U embutido em JS (${m3u.length} itens): ${sourceUrl}`);
      results.push(...m3u);
    }
  }

  const startRegex = /[=:]\s*\[\s*\{/g;
  let match;

  while ((match = startRegex.exec(jsCode)) !== null) {
    const bracketStart = jsCode.indexOf('[', match.index);
    if (bracketStart === -1) continue;

    let depth = 0;
    let inString = false;
    let stringChar = '';
    let escaped = false;
    let endIdx = -1;

    for (let i = bracketStart; i < jsCode.length; i++) {
      const ch = jsCode[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (inString) { if (ch === stringChar) inString = false; continue; }
      if (ch === '"' || ch === "'" || ch === '`') { inString = true; stringChar = ch; continue; }
      if (ch === '[') depth++;
      else if (ch === ']') {
        depth--;
        if (depth === 0) { endIdx = i; break; }
      }
    }

    if (endIdx !== -1 && (endIdx - bracketStart) > 500) {
      const candidate = jsCode.slice(bracketStart, endIdx + 1);
      try {
        const evaluated = new Function(`return ${candidate}`)();
        if (Array.isArray(evaluated) && evaluated.length > 5 && typeof evaluated[0] === 'object') {
          results.push(...evaluated);
          startRegex.lastIndex = endIdx;
        }
      } catch (_) {}
    }
  }

  return results;
}

/**
 * Classifica cada item entre filmes, series, animes ou doramas
 */
function classifyVodItem(raw) {
  const hint = `${raw._activeTab || ''} ${raw._sourceUrl || ''} ${raw._sourceKey || ''} ${raw.cat || ''} ${raw.type || ''} ${raw.tipo || ''}`.toLowerCase();
  const genreAndTitle = `${raw.genre || ''} ${raw.genero || ''} ${raw.group || ''} ${raw.category || ''} ${raw.categoria || ''} ${raw.title || ''} ${raw.name || ''} ${raw.nome || ''}`.toLowerCase();

  if (hint.includes('dorama') || genreAndTitle.includes('dorama') || genreAndTitle.includes('k-drama') || genreAndTitle.includes('coreano')) {
    return 'doramas';
  }
  if (hint.includes('anime') || genreAndTitle.includes('anime') || genreAndTitle.includes('crunchyroll') || genreAndTitle.includes('animação japonesa')) {
    return 'animes';
  }
  if (
    hint.includes('serie') ||
    hint.includes('série') ||
    genreAndTitle.includes('série') ||
    genreAndTitle.includes('serie') ||
    genreAndTitle.includes('temporada') ||
    /s\d{1,2}\s*e\d{1,2}/i.test(genreAndTitle) ||
    /t\d{1,2}\s*ep?\d{1,2}/i.test(genreAndTitle) ||
    raw.seasons ||
    raw.episodes ||
    raw.episodios ||
    (Array.isArray(raw.fontes) && raw.fontes.length > 1 && typeof raw.fontes[0] === 'object' && (raw.fontes[0].episodio || raw.fontes[0].ep || raw.fontes[0].season))
  ) {
    return 'series';
  }
  return 'filmes';
}

function deduplicate(items) {
  const seen = new Set();
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it.title && (!it.fontes || it.fontes.length === 0)) continue;
    const key = `${it.title}|${it.cat}|${JSON.stringify(it.fontes[0] || '')}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(it);
    }
  }
  return out;
}

function saveJsonFile(filename, items) {
  const fullPath = path.join(__dirname, filename);
  fs.writeFileSync(fullPath, JSON.stringify(items, null, 2), 'utf-8');
  console.log(`  [✓] Arquivo ${filename} salvo com ${items.length.toLocaleString('pt-BR')} registros.`);
}

/**
 * Divide a lista de séries em 3 partes iguais:
 * series_sm_pt1.json, series_sm_pt2.json, series_sm_pt3.json
 */
function saveSeriesIn3Parts(seriesArray) {
  const total = seriesArray.length;
  const partSize = Math.ceil(total / 3) || 0;

  const pt1 = seriesArray.slice(0, partSize);
  const pt2 = seriesArray.slice(partSize, partSize * 2);
  const pt3 = seriesArray.slice(partSize * 2);

  saveJsonFile('series_sm_pt1.json', pt1);
  saveJsonFile('series_sm_pt2.json', pt2);
  saveJsonFile('series_sm_pt3.json', pt3);
}

/**
 * Faz o scraping configurando cabeçalhos brasileiros (pt-BR) e testando sub-rotas se der 404
 */
async function scrapeSite(browser, baseUrl, isVod = false) {
  console.log(`\n======================================================`);
  console.log(`ACESSANDO: ${baseUrl}`);
  console.log(`======================================================`);

  const page = await browser.newPage();

  // Simula navegador no Brasil para evitar bloqueio regional 404 em Workers/Pages
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36');
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    'CF-IPCountry': 'BR',
    'X-Forwarded-For': '177.67.80.1'
  });

  const collected = [];
  let activeTab = '';

  page.on('response', async (res) => {
    const rUrl = res.url();
    const status = res.status();
    const cType = (res.headers()['content-type'] || '').toLowerCase();

    if (rUrl.startsWith('data:') || /\.(png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|css)(\?|$)/i.test(rUrl) || rUrl.includes('tmdb.org/t/p')) {
      return;
    }

    console.log(`  [Rede ${status}] (${cType.split(';')[0] || 'unknown'}) -> ${rUrl}`);
    if (status >= 400) return;

    try {
      const text = await res.text();
      if (!text || text.length < 20) return;

      if (text.includes('#EXTINF:')) {
        const parsed = parseM3U(text, isVod ? (activeTab || 'Filmes') : 'Canais');
        console.log(`    -> [+] M3U extraído (${parsed.length} itens)`);
        parsed.forEach(p => collected.push({ ...p, _sourceUrl: rUrl, _activeTab: activeTab }));
        return;
      }

      const trimmed = text.trim();
      if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        try {
          const json = JSON.parse(trimmed);
          if (Array.isArray(json) && json.length > 0) {
            console.log(`    -> [+] Array JSON (${json.length} itens)`);
            json.forEach(it => collected.push({ ...it, _sourceUrl: rUrl, _activeTab: activeTab }));
            return;
          } else if (json && typeof json === 'object') {
            for (const [k, v] of Object.entries(json)) {
              if (Array.isArray(v) && v.length > 0) {
                console.log(`    -> [+] Objeto JSON["${k}"] (${v.length} itens)`);
                v.forEach(it => collected.push({ ...it, _sourceUrl: rUrl, _sourceKey: k, _activeTab: activeTab }));
              }
            }
            return;
          }
        } catch (_) {}
      }

      if (cType.includes('javascript') || cType.includes('html') || rUrl.endsWith('.js')) {
        const fromJs = extractJsLiteralArrays(text, rUrl);
        fromJs.forEach(it => collected.push({ ...it, _sourceUrl: rUrl, _activeTab: activeTab }));
      }
    } catch (_) {}
  });

  const mainRes = await page.goto(baseUrl, { waitUntil: 'networkidle2', timeout: 90000 }).catch(() => null);

  // Se o Cloudflare Pages retornar 404 na raiz, sonda caminhos comuns de listas estáticas
  if (!mainRes || mainRes.status() === 404) {
    console.warn(`  [!] O endereço ${baseUrl} retornou HTTP 404 nos servidores do GitHub Actions!`);
    const cleanBase = baseUrl.replace(/\/$/, '');
    const probePaths = isVod
      ? ['/index.html', '/filmes.json', '/series.json', '/animes.json', '/doramas.json', '/catalogo.json', '/data.json', '/lista.m3u']
      : ['/index.html', '/canais.json', '/channels.json', '/lista.m3u', '/canais.m3u', '/tv.json'];

    for (const p of probePaths) {
      try {
        const probeUrl = `${cleanBase}${p}`;
        const r = await axios.get(probeUrl, {
          timeout: 8000,
          headers: { 'Accept-Language': 'pt-BR', 'User-Agent': 'Mozilla/5.0' }
        });
        if (r.status === 200 && r.data) {
          console.log(`  [+] Rota alternativa encontrada: ${probeUrl}`);
          if (Array.isArray(r.data)) collected.push(...r.data);
          else if (typeof r.data === 'string' && r.data.includes('#EXTINF:')) {
            collected.push(...parseM3U(r.data, isVod ? 'Filmes' : 'Canais'));
          }
        }
      } catch (_) {}
    }
  } else {
    await new Promise(r => setTimeout(r, 5000));
    if (isVod) {
      const tabs = [
        { key: 'filmes', label: 'Filmes' },
        { key: 'series', label: 'Séries' },
        { key: 'animes', label: 'Animes' },
        { key: 'doramas', label: 'Doramas' }
      ];
      for (const t of tabs) {
        activeTab = t.key;
        await page.evaluate((lbl) => {
          const all = Array.from(document.querySelectorAll('div, button, a, span, li'));
          const el = all.find(node => (node.innerText || '').trim().startsWith(lbl) && (node.innerText || '').length < 45);
          if (el) el.click();
        }, t.label);
        await new Promise(r => setTimeout(r, 3500));
      }
    }
  }

  await page.close();
  return collected;
}

(async () => {
  // Remove arquivos indesejados (séries_sm.json com acento e series_sm.json único)
  for (const oldFile of ['séries_sm.json', 'series_sm.json']) {
    const p = path.join(__dirname, oldFile);
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      console.log(`[Limpeza] Removido: ${oldFile}`);
    }
  }

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  try {
    // 1. CANAIS
    const rawCanais = await scrapeSite(browser, URL_CANAIS, false);
    const canaisFormatted = deduplicate(
      rawCanais.map(item => formatToCartoonzineSchema(item, 'Canais'))
    );
    saveJsonFile('canais_sm.json', canaisFormatted);

    // 2. VOD (FILMES, SÉRIES EM 3 PARTES, ANIMES, DORAMAS)
    let rawVod = await scrapeSite(browser, URL_VOD, true);

    // Fallback inteligente: se o pages.dev retornar 404 para o IP do GitHub Actions, busca da bridge de referência
    if (rawVod.length === 0) {
      console.log(`  [Fallback] Buscando dados de referência em: ${FALLBACK_FILMES_URL}`);
      try {
        const { data } = await axios.get(FALLBACK_FILMES_URL, { timeout: 30000 });
        if (Array.isArray(data)) {
          console.log(`  [+] Carregados ${data.length} itens via Fallback!`);
          rawVod = data;
        }
      } catch (e) {
        console.warn(`  [!] Falha no fallback:`, e.message);
      }
    }

    const buckets = { filmes: [], series: [], animes: [], doramas: [] };

    for (let i = 0; i < rawVod.length; i++) {
      const raw = rawVod[i];
      const category = classifyVodItem(raw);
      const labelMap = { filmes: 'Filmes', series: 'Séries', animes: 'Animes', doramas: 'Doramas' };
      buckets[category].push(formatToCartoonzineSchema(raw, labelMap[category]));
    }

    saveJsonFile('filmes_sm.json', deduplicate(buckets.filmes));
    saveSeriesIn3Parts(deduplicate(buckets.series));
    saveJsonFile('animes_sm.json', deduplicate(buckets.animes));
    saveJsonFile('doramas_sm.json', deduplicate(buckets.doramas));

  } catch (err) {
    console.error('[Erro Fatal]:', err);
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
