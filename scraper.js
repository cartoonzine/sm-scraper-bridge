const axios = require('axios');
const fs = require('fs');
const path = require('path');

const CANAIS_BASE_URL = 'https://canais-saimo.pages.dev';
const FILMES_BASE_URL = 'https://filmes-saimo.pages.dev';
const OUTPUT_DIR = path.join(__dirname, 'listas');

const http = axios.create({
  timeout: 30000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    'Accept': 'text/plain, */*'
  },
  responseType: 'text',
  transformResponse: [(data) => data] // Mantém sempre texto puro sem tentar fazer JSON.parse automático
});

async function fetchText(url) {
  try {
    const res = await http.get(url);
    if (res.status >= 200 && res.status < 300 && typeof res.data === 'string') {
      return res.data;
    }
  } catch (_) {}
  return '';
}

/**
 * Converte "0:1001" ou "1:9001.mkv" no endereço HTTP real usando a tabela de bases do indice.txt
 */
function expandSourceUrl(rawSource, bases) {
  const s = (rawSource || '').trim();
  if (!s) return '';
  if (s.startsWith('http://') || s.startsWith('https://')) {
    return s;
  }

  const colonIdx = s.indexOf(':');
  if (colonIdx !== -1) {
    const baseNum = s.slice(0, colonIdx).trim();
    let rest = s.slice(colonIdx + 1).trim();
    const baseUrl = bases[baseNum];
    if (baseUrl && rest) {
      // Regra oficial do formato Saimo: se o resto não tem ponto, ganha .mp4
      if (!rest.includes('.')) {
        rest = `${rest}.mp4`;
      }
      const cleanBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
      return `${cleanBase}${rest}`;
    }
  }
  return s;
}

/**
 * Extrai a lista de URLs de uma string "dub=0:1001,https://..." ou "0:1001,1:2002"
 */
function parseSourceList(rawField, bases) {
  const clean = rawField.replace(/^(dub|leg)=/i, '').trim();
  if (!clean) return [];
  return clean
    .split(',')
    .map((part) => expandSourceUrl(part, bases))
    .filter((u) => u.startsWith('http://') || u.startsWith('https://'));
}

/**
 * 1. CANAIS: Lê catalogo.txt e canais.txt (M3U reserva) de https://canais-saimo.pages.dev/
 */
async function scrapeCanais() {
  console.log('\n=== 1. EXTRAINDO CANAIS (canais-saimo.pages.dev) ===');
  const catalogoTxt = await fetchText(`${CANAIS_BASE_URL}/catalogo.txt`);
  const canaisM3uTxt = await fetchText(`${CANAIS_BASE_URL}/canais.txt`);

  const channelsMap = new Map();
  let currentChannel = null;

  if (catalogoTxt) {
    const lines = catalogoTxt.split(/\r?\n/);
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;

      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;

      const key = line.slice(0, colonIdx).trim().toLowerCase();
      const val = line.slice(colonIdx + 1).trim();

      if (key === 'canal') {
        const normKey = val.toLowerCase().replace(/\s+hd$/i, '').trim();
        if (!channelsMap.has(normKey)) {
          currentChannel = {
            cat: 'Canais',
            title: val,
            desc: '',
            thumb: '',
            bannerThumb: '',
            year: '',
            genre: 'Canais',
            fontes: []
          };
          channelsMap.set(normKey, currentChannel);
        } else {
          currentChannel = channelsMap.get(normKey);
        }
      } else if (currentChannel) {
        if (key === 'logo' && val && !currentChannel.thumb) {
          currentChannel.thumb = val;
          currentChannel.bannerThumb = val;
        } else if (key === 'categoria' && val) {
          currentChannel.genre = val;
        } else if (key === 'fonte' && val.startsWith('http')) {
          if (!currentChannel.fontes.includes(val)) {
            currentChannel.fontes.push(val);
          }
        }
      }
    }
  }

  // Lê canais.txt (M3U de reserva)
  if (canaisM3uTxt && canaisM3uTxt.includes('#EXTINF:')) {
    const lines = canaisM3uTxt.split(/\r?\n/);
    let pending = null;
    for (let line of lines) {
      line = line.trim();
      if (!line) continue;
      if (line.startsWith('#EXTINF:')) {
        const logo = (line.match(/tvg-logo="([^"]*)"/i) || [])[1] || '';
        const group = (line.match(/group-title="([^"]*)"/i) || [])[1] || 'Canais';
        const title = line.split(',').pop()?.trim() || '';
        pending = { title, logo, group };
      } else if (!line.startsWith('#') && pending && line.startsWith('http')) {
        const normKey = pending.title.toLowerCase().replace(/\s+hd$/i, '').trim();
        if (channelsMap.has(normKey)) {
          const existing = channelsMap.get(normKey);
          if (!existing.fontes.includes(line)) existing.fontes.push(line);
          if (!existing.thumb && pending.logo) {
            existing.thumb = pending.logo;
            existing.bannerThumb = pending.logo;
          }
        } else if (pending.title) {
          channelsMap.set(normKey, {
            cat: 'Canais',
            title: pending.title,
            desc: '',
            thumb: pending.logo,
            bannerThumb: pending.logo,
            year: '',
            genre: pending.group,
            fontes: [line]
          });
        }
        pending = null;
      }
    }
  }

  const finalChannels = Array.from(channelsMap.values()).filter((c) => c.fontes.length > 0);
  console.log(`  [+] Total de Canais com stream extraídos: ${finalChannels.length}`);
  return finalChannels;
}

/**
 * 2. METADADOS DO ACERVO: Lê indice.txt, fichas.txt, generos.txt e detalhes.txt
 */
async function loadVodMetadata() {
  console.log('\n=== 2. CARREGANDO ÍNDICE E FICHAS (filmes-saimo.pages.dev) ===');
  const [indiceTxt, fichasTxt, generosTxt, detalhesTxt] = await Promise.all([
    fetchText(`${FILMES_BASE_URL}/indice.txt`),
    fetchText(`${FILMES_BASE_URL}/fichas.txt`),
    fetchText(`${FILMES_BASE_URL}/generos.txt`),
    fetchText(`${FILMES_BASE_URL}/detalhes.txt`)
  ]);

  const bases = {};
  const letters = [];

  // Parseia indice.txt
  for (const rawLine of indiceTxt.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('base:')) {
      const m = line.match(/^base:\s*(\d+)\s+(\S+)/i);
      if (m) bases[m[1]] = m[2];
    } else if (!line.startsWith('#') || line.startsWith('#\t')) {
      const cols = line.split('\t');
      if (cols.length >= 3) {
        letters.push({
          letter: cols[0].trim(),
          moviesCount: parseInt(cols[1], 10) || 0,
          seriesCount: parseInt(cols[2], 10) || 0
        });
      }
    }
  }

  console.log(`  [+] Servidores base encontrados no indice.txt: ${Object.keys(bases).length}`);
  console.log(`  [+] Letras ativas no indice.txt: ${letters.length}`);

  // Mapa de metadados por "tipo|título" (ex: "f|A Casa (2026)" ou "s|A Série")
  const metaMap = new Map();
  let capaBase = 'https://image.tmdb.org/t/p/w342';

  const getOrCreateMeta = (tipo, title) => {
    const key = `${tipo.toLowerCase()}|${title.trim().toLowerCase()}`;
    if (!metaMap.has(key)) {
      metaMap.set(key, { thumb: '', genre: '', year: '', desc: '' });
    }
    return metaMap.get(key);
  };

  // Parseia fichas.txt: tipo \t título \t id TMDB \t capa \t gêneros
  if (fichasTxt) {
    for (const rawLine of fichasTxt.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      if (line.startsWith('capa:')) {
        capaBase = line.slice(5).trim().replace(/\/$/, '');
        continue;
      }
      const cols = line.split('\t');
      if (cols.length >= 4) {
        const [tipo, titulo, , capaRaw, generos] = cols;
        const meta = getOrCreateMeta(tipo, titulo);
        if (capaRaw) {
          meta.thumb = capaRaw.startsWith('http') ? capaRaw : `${capaBase}${capaRaw.startsWith('/') ? '' : '/'}${capaRaw}`;
        }
        if (generos) meta.genre = generos.trim();
      }
    }
  }

  // Parseia generos.txt: tipo \t título \t gêneros
  if (generosTxt) {
    for (const rawLine of generosTxt.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const cols = line.split('\t');
      if (cols.length >= 3) {
        const [tipo, titulo, generos] = cols;
        const meta = getOrCreateMeta(tipo, titulo);
        if (generos && !meta.genre) meta.genre = generos.trim();
      }
    }
  }

  // Parseia detalhes.txt: tipo \t título \t ano \t nota \t classificação \t popularidade
  if (detalhesTxt) {
    for (const rawLine of detalhesTxt.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const cols = line.split('\t');
      if (cols.length >= 3) {
        const [tipo, titulo, ano, nota, classificacao] = cols;
        const meta = getOrCreateMeta(tipo, titulo);
        if (ano) meta.year = ano.trim();
        if (nota || classificacao) {
          meta.desc = [nota ? `Nota: ${nota}` : '', classificacao ? `Classificação: ${classificacao}` : '']
            .filter(Boolean)
            .join(' | ');
        }
      }
    }
  }

  console.log(`  [+] Fichas e metadados carregados: ${metaMap.size.toLocaleString('pt-BR')} títulos`);
  return { bases, letters, metaMap };
}

/**
 * 3. FILMES: Lê filmes-<LETRA>.txt de A a Z e #
 */
async function scrapeFilmes(bases, letters, metaMap) {
  console.log('\n=== 3. EXTRAINDO FILMES (filmes-<LETRA>.txt) ===');
  const activeLetters = letters.length > 0
    ? letters.filter((l) => l.moviesCount > 0).map((l) => l.letter)
    : ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')];

  const movies = [];

  const responses = await Promise.all(
    activeLetters.map(async (letter) => {
      const fileLetter = letter === '#' ? '%23' : letter;
      let txt = await fetchText(`${FILMES_BASE_URL}/filmes-${fileLetter}.txt`);
      if (!txt && letter === '#') {
        txt = await fetchText(`${FILMES_BASE_URL}/filmes-#.txt`);
      }
      return { letter, txt };
    })
  );

  for (const { txt } of responses) {
    if (!txt) continue;
    for (const rawLine of txt.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;

      const cols = line.split('\t');
      if (cols.length < 2) continue;

      const rawTitle = cols[0].trim();
      const fontes = [];

      for (let i = 1; i < cols.length; i++) {
        const urls = parseSourceList(cols[i], bases);
        for (const u of urls) {
          if (!fontes.includes(u)) fontes.push(u);
        }
      }

      if (fontes.length === 0) continue;

      const meta = metaMap.get(`f|${rawTitle.toLowerCase()}`) || {};
      const yearMatch = rawTitle.match(/\((\d{4})\)\s*$/);
      const cleanTitle = rawTitle.replace(/\s*\(\d{4}\)\s*$/, '').trim();
      const year = meta.year || (yearMatch ? yearMatch[1] : '');

      movies.push({
        cat: 'Filmes',
        title: cleanTitle,
        desc: meta.desc || '',
        thumb: meta.thumb || '',
        bannerThumb: meta.thumb || '',
        year,
        genre: meta.genre || 'Filmes',
        fontes
      });
    }
  }

  console.log(`  [+] Total de Filmes extraídos com link direto: ${movies.length.toLocaleString('pt-BR')}`);
  return movies;
}

/**
 * 4. SÉRIES: Lê series-<LETRA>.txt e todos os pedaços series-<LETRA>-<N>.txt
 */
async function scrapeSeries(bases, letters, metaMap) {
  console.log('\n=== 4. EXTRAINDO SÉRIES E EPISÓDIOS (series-<LETRA>-<N>.txt) ===');
  const activeLetters = letters.length > 0
    ? letters.filter((l) => l.seriesCount > 0).map((l) => l.letter)
    : ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')];

  const seriesMap = new Map();

  for (const letter of activeLetters) {
    const fileLetter = letter === '#' ? '%23' : letter;
    const listTxt = await fetchText(`${FILMES_BASE_URL}/series-${fileLetter}.txt`);
    if (!listTxt) continue;

    const chunksToFetch = new Set();

    // Lê series-<LETRA>.txt: título \t ano \t pedaço \t episódios
    for (const rawLine of listTxt.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const cols = line.split('\t');
      if (cols.length < 3) continue;

      const title = cols[0].trim();
      const year = (cols[1] || '').trim();
      const chunkNum = (cols[2] || '0').trim();
      chunksToFetch.add(chunkNum);

      const sKey = `${title.toLowerCase()}|${year}`;
      const meta = metaMap.get(`s|${title.toLowerCase()}`) || {};

      if (!seriesMap.has(sKey)) {
        seriesMap.set(sKey, {
          cat: 'Séries',
          title,
          desc: meta.desc || '',
          thumb: meta.thumb || '',
          bannerThumb: meta.thumb || '',
          year: year || meta.year || '',
          genre: meta.genre || 'Séries',
          fontes: []
        });
      }
    }

    // Baixa todos os pedaços de episódios daquela letra em paralelo
    const chunkNums = Array.from(chunksToFetch);
    const chunkResponses = await Promise.all(
      chunkNums.map((num) => fetchText(`${FILMES_BASE_URL}/series-${fileLetter}-${num}.txt`))
    );

    for (const chunkTxt of chunkResponses) {
      if (!chunkTxt) continue;
      let currentSerie = null;

      for (const rawLine of chunkTxt.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;

        if (line.startsWith('@')) {
          const headerCols = line.slice(1).split('\t');
          const sTitle = (headerCols[0] || '').trim();
          const sYear = (headerCols[1] || '').trim();
          const sKey = `${sTitle.toLowerCase()}|${sYear}`;

          if (!seriesMap.has(sKey)) {
            const meta = metaMap.get(`s|${sTitle.toLowerCase()}`) || {};
            seriesMap.set(sKey, {
              cat: 'Séries',
              title: sTitle,
              desc: meta.desc || '',
              thumb: meta.thumb || '',
              bannerThumb: meta.thumb || '',
              year: sYear || meta.year || '',
              genre: meta.genre || 'Séries',
              fontes: []
            });
          }
          currentSerie = seriesMap.get(sKey);
        } else if (currentSerie) {
          // Linha de episódio: temporada \t episódio \t versão \t fontes
          const epCols = line.split('\t');
          if (epCols.length >= 4) {
            const urls = parseSourceList(epCols[3], bases);
            for (const u of urls) {
              if (!currentSerie.fontes.includes(u)) {
                currentSerie.fontes.push(u);
              }
            }
          }
        }
      }
    }
  }

  const finalSeries = Array.from(seriesMap.values()).filter((s) => s.fontes.length > 0);
  console.log(`  [+] Total de Séries extraídas com episódios: ${finalSeries.length.toLocaleString('pt-BR')}`);
  return finalSeries;
}

/**
 * 5. ANIMES E DORAMAS: Lê redeflix/links-animes.txt e redeflix/links-doramas.txt
 */
async function scrapeRedeFlixFile(relativePath, categoryLabel, tipoMeta, bases, metaMap) {
  console.log(`\n=== EXTRAINDO ${categoryLabel.toUpperCase()} (${relativePath}) ===`);
  const txt = await fetchText(`${FILMES_BASE_URL}/${relativePath}`);
  if (!txt) {
    console.warn(`  [!] Arquivo ${relativePath} vazio ou não encontrado.`);
    return [];
  }

  const itemsMap = new Map();
  let currentItem = null;

  for (const rawLine of txt.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    if (line.startsWith('@')) {
      // Formato: @título \t ano \t id
      const cols = line.slice(1).split('\t');
      const title = (cols[0] || '').trim();
      const year = (cols[1] || '').trim();
      const key = `${title.toLowerCase()}|${year}`;

      const meta =
        metaMap.get(`${tipoMeta}|${title.toLowerCase()}`) ||
        metaMap.get(`s|${title.toLowerCase()}`) ||
        {};

      if (!itemsMap.has(key)) {
        currentItem = {
          cat: categoryLabel,
          title,
          desc: meta.desc || '',
          thumb: meta.thumb || '',
          bannerThumb: meta.thumb || '',
          year: year || meta.year || '',
          genre: meta.genre || categoryLabel,
          fontes: []
        };
        itemsMap.set(key, currentItem);
      } else {
        currentItem = itemsMap.get(key);
      }
    } else if (currentItem) {
      // temporada \t episódio \t versão \t fontes
      const epCols = line.split('\t');
      const sourceField = epCols[3] || epCols[epCols.length - 1] || '';
      const urls = parseSourceList(sourceField, bases);
      for (const u of urls) {
        if (!currentItem.fontes.includes(u)) {
          currentItem.fontes.push(u);
        }
      }
    }
  }

  const result = Array.from(itemsMap.values()).filter((it) => it.fontes.length > 0);
  console.log(`  [+] Total de ${categoryLabel} extraídos: ${result.length.toLocaleString('pt-BR')}`);
  return result;
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
  try {
    // 1. Canais ao vivo
    const canais = await scrapeCanais();
    saveJsonFile('canais_sm.json', canais);

    // 2. Carrega índice de servidores (bases) e fichas de capas/gêneros
    const { bases, letters, metaMap } = await loadVodMetadata();

    // 3. Filmes
    const filmes = await scrapeFilmes(bases, letters, metaMap);
    saveJsonFile('filmes_sm.json', filmes);

    // 4. Séries (Divididas em 3 partes)
    const series = await scrapeSeries(bases, letters, metaMap);
    saveSeriesIn3Parts(series);

    // 5. Animes
    const animes = await scrapeRedeFlixFile('redeflix/links-animes.txt', 'Animes', 'a', bases, metaMap);
    saveJsonFile('animes_sm.json', animes);

    // 6. Doramas
    const doramas = await scrapeRedeFlixFile('redeflix/links-doramas.txt', 'Doramas', 'd', bases, metaMap);
    saveJsonFile('doramas_sm.json', doramas);

  } catch (err) {
    console.error('[Erro Fatal]:', err);
    process.exit(1);
  }
})();
