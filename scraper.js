const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const URL_CANAIS = 'https://canais-saimo.pages.dev/';
const URL_VOD = 'https://filmes-saimo.pages.dev/';

/**
 * Converte um item bruto (seja de JSON, bundle JS ou M3U) para o formato exato:
 * { cat, title, desc, thumb, bannerThumb, year, genre, fontes }
 */
function formatToCartoonzineSchema(raw, defaultCat = 'Filmes') {
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

  // Monta o campo "fontes" exatamente como o seu sistema lê
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
 * Parser M3U / TXT completo
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
 * Extrai arrays de objetos que estejam embutidos dentro de arquivos .js (bundles)
 */
function extractArraysFromJsText(jsText, sourceUrl) {
  const found = [];

  // 1. Verifica se há blocos M3U dentro do JS (template strings `#EXTINF:...`)
  if (jsText.includes('#EXTINF:')) {
    const m3uParsed = parseM3U(jsText);
    if (m3uParsed.length > 0) {
      console.log(`  [+] Bloco M3U encontrado dentro de JS (${m3uParsed.length} itens): ${sourceUrl}`);
      found.push(...m3uParsed);
    }
  }

  // 2. Procura JSON.parse('...') ou JSON.parse("...") embutidos no bundle do Vite/Webpack
  const jsonParseRegex = /JSON\.parse\(\s*(['"`])([\s\S]*?)\1\s*\)/g;
  let match;
  while ((match = jsonParseRegex.exec(jsText)) !== null) {
    try {
      const unescaped = match[2].replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, '\\');
      const parsed = JSON.parse(unescaped);
      const arr = Array.isArray(parsed) ? parsed : Object.values(parsed).find(v => Array.isArray(v));
      if (Array.isArray(arr) && arr.length > 5) {
        console.log(`  [+] JSON.parse embutido em JS (${arr.length} itens): ${sourceUrl}`);
        found.push(...arr);
      }
    } catch (_) {}
  }

  return found;
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
    raw.episodios
  ) {
    return 'series';
  }
  return 'filmes';
}

/**
 * Injeta espiões (hooks) no navegador ANTES da página carregar para capturar
 * qualquer JSON.parse, fetch, XHR ou array gigante na memória do React/Vite
 */
async function attachBrowserHooks(page) {
  await page.evaluateOnNewDocument(() => {
    window.__SM_CAPTURED_ARRAYS__ = [];
    window.__SM_CAPTURED_TEXTS__ = [];

    const recordData = (data, label) => {
      try {
        if (!data) return;
        if (Array.isArray(data) && data.length > 3 && typeof data[0] === 'object' && data[0] !== null) {
          window.__SM_CAPTURED_ARRAYS__.push({ label, items: data });
        } else if (typeof data === 'object') {
          for (const [k, v] of Object.entries(data)) {
            if (Array.isArray(v) && v.length > 3 && typeof v[0] === 'object' && v[0] !== null) {
              window.__SM_CAPTURED_ARRAYS__.push({ label: `${label}.${k}`, items: v });
            }
          }
        }
      } catch (_) {}
    };

    // Hook no JSON.parse nativo da página
    const origParse = JSON.parse;
    JSON.parse = function (...args) {
      const res = origParse.apply(this, args);
      recordData(res, 'JSON.parse');
      return res;
    };

    // Hook no window.fetch nativo da página
    const origFetch = window.fetch;
    window.fetch = async function (...args) {
      const response = await origFetch.apply(this, args);
      try {
        const clone = response.clone();
        const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || 'fetch');
        clone.text().then((txt) => {
          if (txt.includes('#EXTINF:')) {
            window.__SM_CAPTURED_TEXTS__.push({ url, text: txt });
          } else if (txt.trim().startsWith('[') || txt.trim().startsWith('{')) {
            try {
              const parsed = origParse(txt);
              recordData(parsed, `fetch:${url}`);
            } catch (_) {}
          }
        }).catch(() => {});
      } catch (_) {}
      return response;
    };
  });
}

/**
 * Coleta dados profundos da página (Hooks + IndexedDB + LocalStorage + DOM)
 */
async function collectFromPageMemory(page) {
  return await page.evaluate(async () => {
    const arrays = [...(window.__SM_CAPTURED_ARRAYS__ || [])];
    const texts = [...(window.__SM_CAPTURED_TEXTS__ || [])];

    // 1. Varre todas as variáveis globais no window
    for (const key of Object.keys(window)) {
      if (key.startsWith('__SM_')) continue;
      try {
        const val = window[key];
        if (Array.isArray(val) && val.length > 3 && typeof val[0] === 'object' && val[0] !== null) {
          arrays.push({ label: `window.${key}`, items: val });
        } else if (val && typeof val === 'object' && ! (val instanceof Element) && val !== window && val !== document) {
          for (const [subK, subV] of Object.entries(val)) {
            if (Array.isArray(subV) && subV.length > 3 && typeof subV[0] === 'object' && subV[0] !== null) {
              arrays.push({ label: `window.${key}.${subK}`, items: subV });
            }
          }
        }
      } catch (_) {}
    }

    // 2. Varre bancos IndexedDB (muito usado em catálogos grandes no pages.dev)
    if (window.indexedDB && typeof window.indexedDB.databases === 'function') {
      try {
        const dbs = await window.indexedDB.databases();
        for (const dbInfo of dbs) {
          if (!dbInfo.name) continue;
          await new Promise((resolve) => {
            const req = window.indexedDB.open(dbInfo.name);
            req.onsuccess = () => {
              const db = req.result;
              const storeNames = Array.from(db.objectStoreNames);
              if (storeNames.length === 0) return resolve();
              let pending = storeNames.length;
              for (const sName of storeNames) {
                try {
                  const tx = db.transaction(sName, 'readonly');
                  const store = tx.objectStore(sName);
                  const getAllReq = store.getAll();
                  getAllReq.onsuccess = () => {
                    const res = getAllReq.result;
                    if (Array.isArray(res) && res.length > 0) {
                      arrays.push({ label: `IndexedDB:${dbInfo.name}.${sName}`, items: res });
                    }
                    if (--pending === 0) resolve();
                  };
                  getAllReq.onerror = () => { if (--pending === 0) resolve(); };
                } catch (_) {
                  if (--pending === 0) resolve();
                }
              }
            };
            req.onerror = () => resolve();
          });
        }
      } catch (_) {}
    }

    // 3. Fallback DOM: captura os cards visíveis na tela se nada mais existir
    const domCards = [];
    document.querySelectorAll('img').forEach((img) => {
      const card = img.closest('div, a, li, article');
      if (!card) return;
      const title = (card.innerText || img.alt || '').split('\n')[0].trim();
      const thumb = img.src || img.getAttribute('data-src') || '';
      const link = card.querySelector('a')?.href || card.getAttribute('data-url') || card.getAttribute('data-src') || '';
      if (title && thumb && !thumb.includes('data:image/svg')) {
        domCards.push({ title, thumb, url: link });
      }
    });

    return {
      arrays,
      texts,
      domCards,
      pageTitle: document.title,
      bodySample: (document.body?.innerText || '').slice(0, 400).replace(/\s+/g, ' ')
    };
  });
}

/**
 * Remove duplicados mantendo performance para +40 mil itens
 */
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

/**
 * Salva o arquivo JSON sempre (para o git add não falhar)
 */
function saveJsonFile(filename, items) {
  const fullPath = path.join(__dirname, filename);
  fs.writeFileSync(fullPath, JSON.stringify(items, null, 2), 'utf-8');
  console.log(`  [✓] Arquivo ${filename} gerado com ${items.length.toLocaleString('pt-BR')} registros.`);
}

/**
 * Faz o scraping completo de uma URL (.pages.dev)
 */
async function scrapeSite(browser, url, isVod = false) {
  console.log(`\n======================================================`);
  console.log(`ACESSANDO: ${url}`);
  console.log(`======================================================`);

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36');
  await attachBrowserHooks(page);

  const networkItems = [];
  let activeTab = '';

  page.on('response', async (res) => {
    const rUrl = res.url();
    const status = res.status();
    const cType = (res.headers()['content-type'] || '').toLowerCase();

    // Ignora imagens e fontes
    if (/\.(png|jpg|jpeg|gif|webp|svg|ico|woff2?|ttf|css)(\?|$)/i.test(rUrl) || rUrl.includes('tmdb.org/t/p') || rUrl.includes('fonts.')) {
      return;
    }

    console.log(`  [Rede ${status}] (${cType.split(';')[0] || 'unknown'}) -> ${rUrl}`);

    try {
      const text = await res.text();
      if (!text || text.length < 20) return;

      // Caso 1: Lista M3U / EXTINF
      if (text.includes('#EXTINF:')) {
        const parsed = parseM3U(text, isVod ? (activeTab || 'Filmes') : 'Canais');
        console.log(`    -> [+] M3U extraído da rede: ${parsed.length} itens`);
        parsed.forEach(p => networkItems.push({ ...p, _sourceUrl: rUrl, _activeTab: activeTab }));
        return;
      }

      // Caso 2: Resposta JSON direta (mesmo se vier com content-type text/plain ou octet-stream)
      const trimmed = text.trim();
      if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        try {
          const json = JSON.parse(trimmed);
          if (Array.isArray(json) && json.length > 0) {
            console.log(`    -> [+] Array JSON direto: ${json.length} itens`);
            json.forEach(it => networkItems.push({ ...it, _sourceUrl: rUrl, _activeTab: activeTab }));
            return;
          } else if (json && typeof json === 'object') {
            for (const [k, v] of Object.entries(json)) {
              if (Array.isArray(v) && v.length > 0) {
                console.log(`    -> [+] Objeto JSON["${k}"]: ${v.length} itens`);
                v.forEach(it => networkItems.push({ ...it, _sourceUrl: rUrl, _sourceKey: k, _activeTab: activeTab }));
              }
            }
            return;
          }
        } catch (_) {}
      }

      // Caso 3: Bundle JavaScript (.js) que pode conter dados embutidos
      if (cType.includes('javascript') || rUrl.endsWith('.js')) {
        const fromJs = extractArraysFromJsText(text, rUrl);
        fromJs.forEach(it => networkItems.push({ ...it, _sourceUrl: rUrl, _activeTab: activeTab }));
      }
    } catch (_) {}
  });

  await page.goto(url, { waitUntil: 'networkidle2', timeout: 120000 });
  // Aguarda descomprimir listas grandes ou carregar WebWorkers/IndexedDB
  await new Promise(r => setTimeout(r, 6000));

  if (isVod) {
    const tabs = [
      { key: 'filmes', label: 'Filmes' },
      { key: 'series', label: 'Séries' },
      { key: 'animes', label: 'Animes' },
      { key: 'doramas', label: 'Doramas' }
    ];

    for (const t of tabs) {
      activeTab = t.key;
      console.log(`  [>] Clicando na aba: ${t.label}...`);
      await page.evaluate((lbl) => {
        const all = Array.from(document.querySelectorAll('div, button, a, span, li'));
        const el = all.find(node => (node.innerText || '').trim().startsWith(lbl) && (node.innerText || '').length < 45);
        if (el) el.click();
      }, t.label);
      await new Promise(r => setTimeout(r, 4000));
    }
  }

  // Coleta tudo que foi interceptado pelos hooks na memória do navegador
  const mem = await collectFromPageMemory(page);
  console.log(`  [Diagnóstico da Página] Título: "${mem.pageTitle}" | Texto inicial: "${mem.bodySample}"`);

  for (const group of mem.arrays) {
    console.log(`  [+] Capturado na memória (${group.label}): ${group.items.length} itens`);
    group.items.forEach(it => {
      if (it && typeof it === 'object') {
        networkItems.push({ ...it, _sourceKey: group.label });
      }
    });
  }

  for (const txtObj of mem.texts) {
    const parsed = parseM3U(txtObj.text, isVod ? 'Filmes' : 'Canais');
    console.log(`  [+] M3U capturado via Hook Fetch (${txtObj.url}): ${parsed.length} itens`);
    parsed.forEach(it => networkItems.push({ ...it, _sourceUrl: txtObj.url }));
  }

  if (networkItems.length === 0 && mem.domCards.length > 0) {
    console.log(`  [+] Usando fallback de cards do DOM: ${mem.domCards.length} itens`);
    networkItems.push(...mem.domCards);
  }

  await page.close();
  return networkItems;
}

(async () => {
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

    // 2. VOD (FILMES, SÉRIES, ANIMES, DORAMAS)
    const rawVod = await scrapeSite(browser, URL_VOD, true);
    const buckets = {
      filmes: [],
      series: [],
      animes: [],
      doramas: []
    };

    for (let i = 0; i < rawVod.length; i++) {
      const raw = rawVod[i];
      const category = classifyVodItem(raw);
      const labelMap = {
        filmes: 'Filmes',
        series: 'Séries',
        animes: 'Animes',
        doramas: 'Doramas'
      };
      const formatted = formatToCartoonzineSchema(raw, labelMap[category]);
      buckets[category].push(formatted);
    }

    const filmesFinal = deduplicate(buckets.filmes);
    const seriesFinal = deduplicate(buckets.series);
    const animesFinal = deduplicate(buckets.animes);
    const doramasFinal = deduplicate(buckets.doramas);

    saveJsonFile('filmes_sm.json', filmesFinal);
    saveJsonFile('series_sm.json', seriesFinal);
    saveJsonFile('séries_sm.json', seriesFinal);
    saveJsonFile('animes_sm.json', animesFinal);
    saveJsonFile('doramas_sm.json', doramasFinal);

  } catch (err) {
    console.error('[Erro Fatal]:', err);
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
