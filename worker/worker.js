const CATEGORIES = ['food', 'transport', 'lodging', 'activities', 'shopping', 'other']
const CURRENCIES = ['VND', 'USD', 'CAD', 'THB']
const DEFAULT_NOTEBOOK_CODE = 'SHAREDTRIP'
const EXCHANGE_CACHE_SECONDS = 60 * 60 * 24
const exchangeCache = new Map()
const MAP_THUMBNAIL_CACHE_SECONDS = 60 * 60 * 24
const mapThumbnailCache = new Map()
const GOOGLE_MAP_HOSTS = ['maps.google.com', 'google.com', 'www.google.com', 'maps.app.goo.gl', 'goo.gl', 'g.co']

const CURRENCY_WORDS = {
  vnd: 'VND',
  dong: 'VND',
  usd: 'USD',
  dollar: 'USD',
  dollars: 'USD',
  cad: 'CAD',
  thb: 'THB',
  baht: 'THB',
}

const todayISO = () => new Date().toISOString().slice(0, 10)

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

function toError(message, status = 500) {
  return json({ error: message }, status)
}

function parseBody(request) {
  return request.json().catch(() => ({}))
}

function safeText(value) {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function getCachedMapThumbnail(urlText) {
  const key = safeText(urlText)
  if (!key) return null
  const cached = mapThumbnailCache.get(key)
  if (!cached) return null
  if (Date.now() - cached.timestamp > MAP_THUMBNAIL_CACHE_SECONDS * 1000) {
    mapThumbnailCache.delete(key)
    return null
  }
  return cached.value
}

function setCachedMapThumbnail(urlText, value) {
  const key = safeText(urlText)
  if (!key) return
  mapThumbnailCache.set(key, {
    value,
    timestamp: Date.now(),
  })
  if (mapThumbnailCache.size > 240) {
    const oldest = mapThumbnailCache.keys().next().value
    if (oldest) mapThumbnailCache.delete(oldest)
  }
}

function isImageUrlCandidate(rawUrl) {
  const value = safeText(rawUrl).toLowerCase()
  if (!value) return false
  if (!value.startsWith('http')) return false
  return (
    value.includes('staticmap') ||
    value.includes('maps/api/staticmap') ||
    value.includes('openstreetmap.de/staticmap') ||
    value.includes('.googleusercontent.com') ||
    value.includes('lh3.googleusercontent.com') ||
    value.includes('gstatic.com') ||
    /\.(jpe?g|png|webp|gif|avif|bmp)(?:\?|#|$)/i.test(value)
  )
}

function unescapeHtmlText(value) {
  if (!value) return ''
  return safeText(value)
    .replace(/\\u003d/gi, '=')
    .replace(/\\u0026/gi, '&')
    .replace(/\\u002f/gi, '/')
    .replace(/\\u0022/gi, '"')
    .replace(/\\u0027/gi, "'")
    .replace(/&amp;/g, '&')
}

function isGoogleMapsUrl(urlText) {
  try {
    const value = safeText(urlText)
    if (!value) return false
    const parsed = new URL(value)
    const host = parsed.hostname.toLowerCase()
    if (!GOOGLE_MAP_HOSTS.some((candidate) => host === candidate || host.endsWith(`.${candidate}`))) return false
    if (host.includes('goo.gl')) return true
    return parsed.pathname.startsWith('/maps') || parsed.pathname.includes('/maps/')
  } catch (error) {
    return false
  }
}

function normalizeImageUrl(rawUrl, baseUrl) {
  try {
    const value = safeText(rawUrl)
    if (!value) return null
    if (value.startsWith('//')) {
      return `https:${value}`
    }
    if (value.startsWith('http://')) return null
    const resolved = new URL(value, baseUrl)
    return resolved.protocol === 'https:' ? resolved.href : null
  } catch (error) {
    return null
  }
}

function extractMetaImage(html, baseUrl) {
  const tags = new Set([
    'og:image:secure_url',
    'og:image',
    'twitter:image',
    'twitter:image:src',
    'twitter:image:secure_url',
    'image',
    'image_src',
  ])
  const metaRegex =
    /<meta[^>]+(?:property|name)=["']([^"']+)["'][^>]+(?:content|value)=["']([^"']+)["'][^>]*>/gi
  for (const match of html.matchAll(metaRegex)) {
    const tag = String(match[1] || '').toLowerCase()
    if (!tags.has(tag)) continue
    const normalized = normalizeImageUrl(unescapeHtmlText(match[2]), baseUrl)
    if (normalized && isImageUrlCandidate(normalized)) return normalized
  }

  const linkRegex = /<link[^>]+rel=["']([^"']+)["'][^>]+href=["']([^"']+)["'][^>]*>/gi
  for (const match of html.matchAll(linkRegex)) {
    const rel = String(match[1] || '').toLowerCase()
    if (!rel.includes('image_src') && !rel.includes('apple-touch-icon') && !rel.includes('icon')) continue
    const normalized = normalizeImageUrl(unescapeHtmlText(match[2]), baseUrl)
    if (normalized && isImageUrlCandidate(normalized)) return normalized
  }

  return null
}

function extractJsonLdImages(html, baseUrl) {
  const matches = html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)
  const candidates = []

  const collect = (value) => {
    if (!value) return
    if (Array.isArray(value)) {
      value.forEach((next) => collect(next))
      return
    }
    if (typeof value === 'string') {
      candidates.push(value)
      return
    }
    if (typeof value !== 'object') return
    if (typeof value.url === 'string') candidates.push(value.url)
    if (typeof value.image === 'string') candidates.push(value.image)
    if (typeof value.logo === 'string') candidates.push(value.logo)
    if (typeof value.contentUrl === 'string') candidates.push(value.contentUrl)
    if (typeof value.thumbnailUrl === 'string') candidates.push(value.thumbnailUrl)
    if (Array.isArray(value.image)) value.image.forEach((next) => collect(next))
    if (typeof value.image === 'object') collect(value.image)
    if (typeof value.photo === 'object') collect(value.photo)
    if (Array.isArray(value.photo)) value.photo.forEach((next) => collect(next))
    if (typeof value.publisher === 'object') collect(value.publisher)
    if (typeof value.potentialAction === 'object') collect(value.potentialAction)
    if (typeof value.target === 'object') collect(value.target)
  }

  for (const match of matches) {
    try {
      const parsed = JSON.parse(safeText(match[1] || '{}'))
      collect(parsed)
    } catch (error) {
      continue
    }
  }

  for (const candidate of candidates) {
    const normalized = normalizeImageUrl(candidate, baseUrl)
    if (!normalized || !isImageUrlCandidate(normalized)) continue
    return normalized
  }
  return null
}

function extractScriptImageCandidates(html, baseUrl) {
  const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi
  const candidates = []

  for (const scriptMatch of html.matchAll(scriptRegex)) {
    const scriptBody = safeText(scriptMatch[1])
    if (!scriptBody) continue

    const maybeJson = scriptBody.match(/(\{[\s\S]*\}|\[[\s\S]*\])/)
    if (maybeJson?.[1]) {
      try {
        const parsed = JSON.parse(maybeJson[1])
        const collect = (value) => {
          if (!value) return
          if (Array.isArray(value)) {
            value.forEach((next) => collect(next))
            return
          }
          if (typeof value === 'string') {
            if (isImageUrlCandidate(value)) candidates.push(value)
            return
          }
          if (typeof value !== 'object') return
          Object.values(value).forEach((next) => collect(next))
        }
        collect(parsed)
      } catch (error) {}
    }

    const imageLikeRegex = /(https?:\/\/[^"'\s<>]+\.(?:jpe?g|png|webp|gif|avif|bmp)(?:[^"'\s<>]*)?)/gi
    for (const candidate of scriptBody.matchAll(imageLikeRegex)) {
      if (candidate?.[1]) candidates.push(candidate[1])
      if (candidates.length > 40) break
    }

    const mapTokenRegex = /(https?:\/\/[^"'\s<>]*(?:lh3\.googleusercontent\.com|\.gstatic\.com)[^"'\s<>]*)/gi
    for (const candidate of scriptBody.matchAll(mapTokenRegex)) {
      if (candidate?.[1]) candidates.push(candidate[1])
      if (candidates.length > 40) break
    }
    if (candidates.length > 40) break
  }

  const rawImageRegex = /(https?:\/\/[^"'\\s<>]+(?:lh3\.googleusercontent\.com|\.gstatic\.com|maps\.googleapis\.com\/maps\/api\/staticmap|openstreetmap\.de\/staticmap\.php)[^"'\\s<>]*)/gi
  for (const match of html.matchAll(rawImageRegex)) {
    if (match?.[1]) candidates.push(match[1])
  }

  const genericImageTagRegex = /<img[^>]+(?:src|srcset|data-src)=["']([^"']+)["'][^>]*>/gi
  for (const match of html.matchAll(genericImageTagRegex)) {
    const raw = match?.[1]
    if (!raw) continue
    if (match[0].includes('srcset')) {
      const set = raw.split(',')
      for (const token of set) {
        const candidate = token.trim().split(' ')[0]
        if (candidate) candidates.push(candidate)
      }
    } else {
      candidates.push(raw)
    }
  }

  const scriptBodyRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi
  for (const scriptMatch of html.matchAll(scriptBodyRegex)) {
    const rawScript = unescapeHtmlText(scriptMatch?.[1] || '')
    for (const match of rawScript.matchAll(rawImageRegex)) {
      if (match?.[1]) candidates.push(match[1])
    }
  }

  const allUrlRegex =
    /["'](https?:\/\/[^"'\s<>]+(?:lh3\.googleusercontent\.com|\.gstatic\.com|maps\.googleapis\.com\/maps\/api\/staticmap|openstreetmap\.de\/staticmap\.php)[^"'\s<>]*)["']/gi
  for (const match of html.matchAll(allUrlRegex)) {
    if (match?.[1]) candidates.push(match[1])
  }

  for (const candidate of candidates) {
    const normalized = normalizeImageUrl(unescapeHtmlText(candidate), baseUrl)
    if (!normalized || !isImageUrlCandidate(normalized)) continue
    return normalized
  }

  return null
}

function decodeMapText(value) {
  try {
    return decodeURIComponent(safeText(value))
  } catch (error) {
    return safeText(value)
  }
}

function parseCoordinatesFromText(value) {
  const raw = safeText(value)
  if (!raw) return null

  const regex = /(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)(?!\d)/g
  let current
  while ((current = regex.exec(raw))) {
    const latitude = Number(current[1])
    const longitude = Number(current[2])
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue
    if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) continue
    return { latitude, longitude }
  }
  return null
}

function parseCoordinatesFromHtml(html) {
  const patterns = [
    /"lat"\s*:\s*(-?\d+(?:\.\d+)?)[,\s}]+\s*"lng"\s*:\s*(-?\d+(?:\.\d+)?)/i,
    /"lng"\s*:\s*(-?\d+(?:\.\d+)?)[,\s}]+\s*"lat"\s*:\s*(-?\d+(?:\.\d+)?)/i,
    /center:\s*\{\s*lat:\s*(-?\d+(?:\.\d+)?)[,\s]*lng:\s*(-?\d+(?:\.\d+)?)/i,
    /center\s*=\s*\{\s*latitude:\s*(-?\d+(?:\.\d+)?),\s*longitude:\s*(-?\d+(?:\.\d+)?)/i,
  ]

  for (const pattern of patterns) {
    const match = html.match(pattern)
    if (!match) continue
    const latitude = Number(match[1])
    const longitude = Number(match[2])
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue
    if (Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180) return { latitude, longitude }
  }

  return parseCoordinatesFromText(html)
}

function extractCoordinateText(value) {
  const match = String(value || '').match(/(-?\d{1,3}(?:\.\d+)?),\s*(-?\d{1,3}(?:\.\d+)?)\s*(?:,|$)/)
  if (!match) return null
  const latitude = Number(match[1])
  const longitude = Number(match[2])
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
  if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null
  return { latitude, longitude }
}

function extractMapPlaceContext(rawUrl) {
  const context = { coordinates: null, searchText: null }
  try {
    const parsed = new URL(rawUrl)
    const params = ['ll', 'sll', 'center', 'q']
    if (parsed.searchParams.get('query')) {
      context.searchText = decodeMapText(parsed.searchParams.get('query'))
    }
    for (const key of params) {
      const raw = parsed.searchParams.get(key)
      if (!raw) continue
      const coordinate = extractCoordinateText(raw)
      if (coordinate) {
        context.coordinates = coordinate
        return context
      }
      if (!context.searchText) context.searchText = decodeMapText(raw)
    }

    const atMatch = parsed.pathname.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/)
    if (atMatch) {
      const latitude = Number(atMatch[1])
      const longitude = Number(atMatch[2])
      if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
        context.coordinates = { latitude, longitude }
        return context
      }
    }

    const searchMatch = parsed.pathname.match(/\/search\/([^/?#]+)/)
    if (searchMatch) {
      context.searchText = decodeMapText(searchMatch[1]).replace(/\+/g, ' ')
      return context
    }

    const placeMatch = parsed.pathname.match(/\/place\/([^/?#]+)/)
    if (placeMatch) {
      context.searchText = decodeMapText(placeMatch[1]).replace(/\+/g, ' ')
      return context
    }

    const mapsSearch = parsed.pathname.match(/\/maps\/search\/([^/?#]+)/)
    if (mapsSearch) {
      context.searchText = decodeMapText(mapsSearch[1]).replace(/\+/g, ' ')
      return context
    }

    const hashMatch = parsed.hash || parsed.pathname
    const hashCoords = rawTextToCoords(hashMatch)
    if (hashCoords) return { ...context, coordinates: hashCoords }
  } catch (error) {}
  const urlCoords = parseCoordinatesFromText(rawUrl)
  if (urlCoords) return { ...context, coordinates: urlCoords }
  return context
}

function rawTextToCoords(rawText) {
  const value = safeText(rawText)
  if (!value) return null
  const hashLatMatch = value.match(/!3d(-?\d+(?:\.\d+)?)/i)
  const hashLngMatch = value.match(/!4d(-?\d+(?:\.\d+)?)/i)
  if (hashLatMatch?.[1] && hashLngMatch?.[1]) {
    const latitude = Number(hashLatMatch[1])
    const longitude = Number(hashLngMatch[1])
    if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
      if (Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180) {
        return { latitude, longitude }
      }
    }
  }
  const altCoords = value.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/)
  if (altCoords) {
    const latitude = Number(altCoords[1])
    const longitude = Number(altCoords[2])
    if (Number.isFinite(latitude) && Number.isFinite(longitude)) return { latitude, longitude }
  }
  return null
}

function tileCoordFromLngLat(latitude, longitude, zoom = 12) {
  const lat = Number(latitude)
  const lon = Number(longitude)
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null
  const latRad = (lat * Math.PI) / 180
  const n = 2 ** zoom
  const x = Math.floor(n * ((lon + 180) / 360))
  const y = Math.floor(
    (n *
      (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) /
      2),
  )
  return { x, y, z: zoom }
}

async function fetchWikipediaLocationImage(context) {
  const latitude = Number(context?.latitude)
  const longitude = Number(context?.longitude)
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null

  try {
    const searchResponse = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&origin=*&list=geosearch&gscoord=${encodeURIComponent(
        `${latitude}|${longitude}`,
      )}&gsradius=5000&gslimit=1`,
    )
    if (!searchResponse.ok) return null
    const searchPayload = await searchResponse.json()
    const page = searchPayload?.query?.geosearch?.[0]
    if (!page?.pageid) return null

    const imageResponse = await fetch(
      `https://en.wikipedia.org/w/api.php?action=query&format=json&origin=*&formatversion=2&prop=pageimages&piprop=original|thumbnail&pageids=${page.pageid}&pithumbsize=500`,
    )
    if (!imageResponse.ok) return null
    const imagePayload = await imageResponse.json()
    const pageData = imagePayload?.query?.pages?.[0]
    const directImage = pageData?.original?.source || pageData?.thumbnail?.source
    if (directImage && directImage.startsWith('https://')) return directImage
  } catch (error) {}
  return null
}

async function geocodeSearchText(searchText) {
  if (!searchText) return null
  const cacheKey = `geocode:${searchText}`
  const cached = mapThumbnailCache.get(cacheKey)
  if (cached && Date.now() - cached.timestamp < MAP_THUMBNAIL_CACHE_SECONDS * 1000) return cached.value

  try {
    const response = await fetch(
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(searchText)}`,
      {
        headers: {
          'user-agent': 'Mozilla/5.0 (compatible; thravel/1.0)',
          accept: 'application/json',
        },
      },
    )
    if (!response.ok) return null
    const payload = await response.json()
    if (!Array.isArray(payload) || !payload.length) return null
    const first = payload[0]
    const latitude = Number(first.lat)
    const longitude = Number(first.lon)
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null
    const coordinates = { latitude, longitude }
    mapThumbnailCache.set(cacheKey, { timestamp: Date.now(), value: coordinates })
    return coordinates
  } catch (error) {
    return null
  }
}

function createMapFallbackImage(context) {
  const latitude = Number(context?.latitude)
  const longitude = Number(context?.longitude)
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return 'https://tile.openstreetmap.org/1/1/1.png'
  }

  const contextTile = tileCoordFromLngLat(latitude, longitude, 14)
  if (!contextTile) return 'https://tile.openstreetmap.org/1/1/1.png'

  return `https://tile.openstreetmap.org/${contextTile.z}/${contextTile.x}/${contextTile.y}.png`
}

async function resolveMapUrl(rawUrl) {
  try {
    const response = await fetch(rawUrl, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
      },
    })
    return response.url
  } catch (error) {
    return safeText(rawUrl)
  }
}

async function resolveMapThumbnailFromUrl(urlText) {
  if (!isGoogleMapsUrl(urlText)) return null

  const cached = getCachedMapThumbnail(urlText)
  if (cached !== null) return cached

  try {
    const resolvedUrl = await resolveMapUrl(urlText)
    const response = await fetch(resolvedUrl, {
      redirect: 'follow',
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
      },
    })
    if (!response.ok) throw new Error('failed to fetch map page')
    const html = await response.text()
    const pageUrl = response.url

    const meta = extractMetaImage(html, pageUrl)
    if (meta) {
      setCachedMapThumbnail(urlText, meta)
      return meta
    }

    const jsonLd = extractJsonLdImages(html, pageUrl)
    if (jsonLd) {
      setCachedMapThumbnail(urlText, jsonLd)
      return jsonLd
    }

    const scriptImage = extractScriptImageCandidates(html, pageUrl)
    if (scriptImage) {
      setCachedMapThumbnail(urlText, scriptImage)
      return scriptImage
    }

    const context = extractMapPlaceContext(pageUrl)
    let coordinates = context?.coordinates
    if (!coordinates) {
      coordinates = parseCoordinatesFromHtml(html)
      if (coordinates) context.coordinates = coordinates
    }
    let wikiImage = null
    if (coordinates) {
      wikiImage = await fetchWikipediaLocationImage(coordinates)
      if (wikiImage) {
        setCachedMapThumbnail(urlText, wikiImage)
        return wikiImage
      }
    }
    if (!coordinates && context?.searchText) {
      coordinates = await geocodeSearchText(context.searchText)
    }
    if (coordinates) {
      wikiImage = await fetchWikipediaLocationImage(coordinates)
      if (wikiImage) {
        setCachedMapThumbnail(urlText, wikiImage)
        return wikiImage
      }
    }

    const fallback = createMapFallbackImage(coordinates)
    setCachedMapThumbnail(urlText, fallback)
    return fallback
  } catch (error) {
    const context = extractMapPlaceContext(urlText)
    let coordinates = context?.coordinates
    let wikiImage = null
    if (coordinates) {
      wikiImage = await fetchWikipediaLocationImage(coordinates)
    }
    if (wikiImage) {
      setCachedMapThumbnail(urlText, wikiImage)
      return wikiImage
    }
    if (!coordinates && context?.searchText) {
      coordinates = await geocodeSearchText(context.searchText)
    }
    if (coordinates) {
      wikiImage = await fetchWikipediaLocationImage(coordinates)
      if (wikiImage) {
        setCachedMapThumbnail(urlText, wikiImage)
        return wikiImage
      }
    }
    const fallback = createMapFallbackImage(coordinates)
    setCachedMapThumbnail(urlText, fallback)
    return fallback
  }
}

function randomId() {
  return crypto.randomUUID()
}

function normalizeCurrency(currency, fallback = 'VND') {
  const next = String(currency || fallback).toUpperCase()
  return CURRENCIES.includes(next) ? next : fallback
}

async function fetchExchangeQuote(amount, from, to) {
  const source = normalizeCurrency(from, 'USD')
  const target = normalizeCurrency(to, 'VND')
  const value = Number(amount)
  if (!Number.isFinite(value)) throw new Error('valid amount required')

  const now = Date.now()
  const cached = exchangeCache.get(source)
  let payload = cached?.payload
  if (!payload || now - cached.timestamp > EXCHANGE_CACHE_SECONDS * 1000) {
    const response = await fetch(`https://open.er-api.com/v6/latest/${source}`)
    if (!response.ok) throw new Error('exchange rates unavailable')
    payload = await response.json()
    if (payload.result !== 'success' || !payload.rates?.[target]) {
      throw new Error('exchange rate unavailable')
    }
    exchangeCache.set(source, { timestamp: now, payload })
  }

  const rate = Number(payload.rates[target])
  return {
    amount: value,
    from: source,
    to: target,
    rate,
    converted: value * rate,
    updated_at: payload.time_last_update_utc,
    next_update_at: payload.time_next_update_utc,
    provider: payload.provider || 'https://www.exchangerate-api.com',
  }
}

function normalizeCategory(text) {
  const value = (text || '').toLowerCase()
  if (/(coffee|meal|restaurant|cafe|food|breakfast|lunch|dinner|snack|tea|drink)/.test(value)) return 'food'
  if (/(taxi|uber|bus|train|flight|plane|airline|metro|fuel|parking|car|transport)/.test(value)) return 'transport'
  if (/(hotel|stay|hostel|room|resort|lodg)/.test(value)) return 'lodging'
  if (/(ticket|museum|tour|entry|activity|show|attraction)/.test(value)) return 'activities'
  if (/(souvenir|shop|clothes|gift|toiletry|market|store)/.test(value)) return 'shopping'
  return 'other'
}

function detectCurrency(text, fallback = 'VND') {
  const lower = text.toLowerCase()
  for (const [word, currency] of Object.entries(CURRENCY_WORDS)) {
    if (lower.includes(word)) return currency
  }
  return fallback
}

function parseFallback(noteText, defaultCurrency = 'VND') {
  const notes = noteText
    .split(/[,\n;]+/)
    .map((part) => part.trim())
    .filter(Boolean)

  const parsed = []
  for (const item of notes) {
    const money = item.match(/-?\d+(?:[.,]\d{1,2})?/g)
    if (!money) continue
    const amount = Number(money[0].replace(',', '.'))
    if (Number.isNaN(amount)) continue
    const merchant = item.replace(money[0], '').replace(/\d+/g, '').replace(/\s+/g, ' ').trim()
    parsed.push({
      amount,
      currency: detectCurrency(item, defaultCurrency),
      category: normalizeCategory(item),
      merchant: merchant || item.slice(0, 28),
      note: item,
      expense_date: todayISO(),
      confidence: 0.35,
    })
  }

  if (!parsed.length) {
    parsed.push({
      amount: 0,
      currency: defaultCurrency,
      category: 'other',
      merchant: '',
      note: noteText,
      expense_date: todayISO(),
      confidence: 0.12,
    })
  }

  return parsed
}

function coerceAiOutput(output, defaultCurrency = 'VND') {
  const items = []
  if (!output) return items

  const raw = typeof output === 'string'
    ? output
    : output.responseText || output.response || output.result || ''

  if (!raw) return items

  try {
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start < 0 || end < start) return items
    const jsonBody = JSON.parse(raw.slice(start, end + 1))
    if (!Array.isArray(jsonBody.items)) return items
    for (const row of jsonBody.items) {
      const amount = Number(row?.amount)
      if (!Number.isFinite(amount)) continue
      items.push({
        amount,
        currency: normalizeCurrency(row.currency, defaultCurrency),
        category: normalizeCategory(row.category || row.note || row.merchant || ''),
        merchant: row.merchant || '',
        note: row.note || '',
        expense_date: row.date || todayISO(),
        confidence: row.confidence ? Number(row.confidence) : 0.85,
      })
    }
    return items
  } catch (error) {
    return items
  }
}

async function parseWithAI(env, noteText, defaultCurrency = 'VND') {
  if (!env.AI) return []
  const prompt = `
You are an expense parser. Return only JSON.
Use ${defaultCurrency} when the note has no currency.
{
  "items": [
    {
      "amount": number,
      "currency": "VND|USD|CAD|THB",
      "category": "food|transport|lodging|activities|shopping|other",
      "merchant": "short text",
      "note": "optional note",
      "date": "YYYY-MM-DD",
      "confidence": 0.0-1.0
    }
  ]
}
Parse this note:
"""${noteText}"""
`
  const models = (
    env.AI_MODEL ||
    '@cf/meta/llama-3.3-70b-instruct,@cf/meta/llama-3.1-70b-instruct,@cf/meta/llama-3-8b-instruct'
  )
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)

  for (const model of models) {
    try {
      const response = await env.AI.run(model, {
        prompt,
        max_tokens: 1200,
        temperature: 0.1,
      })
      const parsed = coerceAiOutput(response, defaultCurrency)
      if (parsed.length) return parsed
    } catch (error) {
      continue
    }
  }

  return []
}

async function getOrCreateDefaultNotebook(db) {
  const existing = await db.prepare('SELECT id, code FROM notebooks WHERE code = ?').bind(DEFAULT_NOTEBOOK_CODE).first()
  if (existing) return { notebookId: existing.id, code: existing.code }

  const id = randomId()
  const now = new Date().toISOString()
  await db.prepare('INSERT INTO notebooks (id, code, created_at) VALUES (?, ?, ?)').bind(id, DEFAULT_NOTEBOOK_CODE, now).run()
  return { notebookId: id, code: DEFAULT_NOTEBOOK_CODE }
}

function shapeTrip(row) {
  if (!row) return null
  return {
    id: row.id,
    destination: row.destination || '',
    currency: row.currency || 'VND',
    status: row.status || 'active',
    started_at: row.started_at,
    ended_at: row.ended_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

async function ensureDefaultTripForExistingExpenses(db, notebookId) {
  const active = await db
    .prepare('SELECT * FROM trips WHERE notebook_id = ? AND status = ? ORDER BY started_at DESC LIMIT 1')
    .bind(notebookId, 'active')
    .first()
  if (active) return shapeTrip(active)

  const orphanCount = await db
    .prepare('SELECT COUNT(*) AS count FROM expenses WHERE notebook_id = ? AND trip_id IS NULL')
    .bind(notebookId)
    .first()

  if (!orphanCount?.count) return null

  const id = 'default-trip'
  const now = new Date().toISOString()
  await db
    .prepare(
      `INSERT OR IGNORE INTO trips
       (id, notebook_id, destination, currency, status, started_at, ended_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, notebookId, '', 'VND', 'active', now, null, now, now)
    .run()
  await db.prepare('UPDATE expenses SET trip_id = ? WHERE notebook_id = ? AND trip_id IS NULL').bind(id, notebookId).run()
  const trip = await db.prepare('SELECT * FROM trips WHERE id = ?').bind(id).first()
  return shapeTrip(trip)
}

async function listTrips(db, notebookId) {
  const result = await db
    .prepare(
      `SELECT t.*,
        COALESCE(SUM(CASE WHEN e.currency = t.currency THEN e.amount ELSE 0 END), 0) AS total
       FROM trips t
       LEFT JOIN expenses e ON e.trip_id = t.id
       WHERE t.notebook_id = ?
       GROUP BY t.id
       ORDER BY t.status = 'active' DESC, t.started_at DESC`,
    )
    .bind(notebookId)
    .all()

  return (result.results || []).map((row) => ({ ...shapeTrip(row), total: Number(row.total || 0) }))
}

async function getTrip(db, tripId) {
  const trip = await db.prepare('SELECT * FROM trips WHERE id = ?').bind(tripId).first()
  return shapeTrip(trip)
}

async function getActiveTrip(db, notebookId) {
  await ensureDefaultTripForExistingExpenses(db, notebookId)
  const trip = await db
    .prepare('SELECT * FROM trips WHERE notebook_id = ? AND status = ? ORDER BY started_at DESC LIMIT 1')
    .bind(notebookId, 'active')
    .first()
  return shapeTrip(trip)
}

async function listExpenses(db, tripId) {
  const result = await db
    .prepare(
      `SELECT id, trip_id, amount, currency, category, merchant, note, expense_date, source_text, confidence, google_map_url, thumbnail_url, created_at, updated_at
       FROM expenses
       WHERE trip_id = ?
       ORDER BY expense_date DESC, created_at DESC`,
    )
    .bind(tripId)
    .all()
  return result.results || []
}

async function insertExpense(db, notebookId, tripId, item, sourceText, defaultCurrency) {
  const id = randomId()
  const now = new Date().toISOString()
  const currency = normalizeCurrency(item.currency, defaultCurrency)
  await db
    .prepare(
      `INSERT INTO expenses
      (id, notebook_id, trip_id, amount, currency, category, merchant, note, expense_date, source_text, google_map_url, thumbnail_url, confidence, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      notebookId,
      tripId,
      item.amount,
      currency,
      item.category || normalizeCategory(item.note),
      item.merchant || '',
      item.note || '',
      item.expense_date || todayISO(),
      sourceText || '',
      item.google_map_url || null,
      item.thumbnail_url || null,
      item.confidence || 0.25,
      now,
      now,
    )
    .run()
  return {
    id,
    trip_id: tripId,
    amount: Number(item.amount),
    currency,
    category: item.category || normalizeCategory(item.note),
    merchant: item.merchant || '',
    note: item.note || '',
    expense_date: item.expense_date || todayISO(),
    source_text: sourceText || '',
    google_map_url: item.google_map_url || null,
    thumbnail_url: item.thumbnail_url || null,
    confidence: item.confidence || 0.25,
    created_at: now,
    updated_at: now,
  }
}

function pathId(path, prefix) {
  const [, id] = path.split(prefix)
  return id || ''
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url)
      const { pathname } = url
      const db = env.DB

      if (!pathname.startsWith('/api/')) {
        if (env.ASSETS?.fetch) return env.ASSETS.fetch(request)
        return toError('Assets binding unavailable', 500)
      }

      if (pathname === '/api/exchange' && request.method === 'GET') {
        const amount = url.searchParams.get('amount') || '1'
        const from = url.searchParams.get('from') || 'USD'
        const to = url.searchParams.get('to') || 'VND'
        return json({ quote: await fetchExchangeQuote(amount, from, to) })
      }

      const notebook = await getOrCreateDefaultNotebook(db)

      if (pathname === '/api/trips' && request.method === 'GET') {
        await ensureDefaultTripForExistingExpenses(db, notebook.notebookId)
        return json({ trips: await listTrips(db, notebook.notebookId) })
      }

      if (pathname === '/api/trips/active' && request.method === 'GET') {
        return json({ trip: await getActiveTrip(db, notebook.notebookId) })
      }

      if (pathname === '/api/trips' && request.method === 'POST') {
        const body = await parseBody(request)
        const existing = await getActiveTrip(db, notebook.notebookId)
        if (existing) return json({ trip: existing })

        const id = randomId()
        const now = new Date().toISOString()
        const currency = normalizeCurrency(body.currency, 'VND')
        await db
          .prepare(
            `INSERT INTO trips
             (id, notebook_id, destination, currency, status, started_at, ended_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(id, notebook.notebookId, body.destination || '', currency, 'active', now, null, now, now)
          .run()
        return json({ trip: await getTrip(db, id) }, 201)
      }

      if (pathname.startsWith('/api/trips/') && pathname.endsWith('/end') && request.method === 'POST') {
        const tripId = pathId(pathname, '/api/trips/').replace('/end', '')
        const now = new Date().toISOString()
        await db.prepare('UPDATE trips SET status = ?, ended_at = ?, updated_at = ? WHERE id = ?').bind('ended', now, now, tripId).run()
        return json({ trip: await getTrip(db, tripId) })
      }

      if (pathname.startsWith('/api/trips/') && request.method === 'PATCH') {
        const tripId = pathId(pathname, '/api/trips/')
        const body = await parseBody(request)
        const existing = await getTrip(db, tripId)
        if (!existing) return toError('trip not found', 404)

        const status = body.status === 'ended' || body.status === 'active' ? body.status : existing.status
        const now = new Date().toISOString()
        await db
          .prepare('UPDATE trips SET destination = ?, currency = ?, status = ?, updated_at = ? WHERE id = ?')
          .bind(body.destination ?? existing.destination, normalizeCurrency(body.currency, existing.currency), status, now, tripId)
          .run()
        return json({ trip: await getTrip(db, tripId) })
      }

      if (pathname === '/api/expenses' && request.method === 'GET') {
        const tripId = url.searchParams.get('tripId')
        if (!tripId) return toError('tripId required', 400)
        const trip = await getTrip(db, tripId)
        if (!trip) return toError('trip not found', 404)
        const expenses = await listExpenses(db, tripId)
        const total = expenses.reduce((sum, item) => sum + Number(item.amount || 0), 0)
        return json({ trip, expenses, total })
      }

      if (pathname === '/api/notes' && request.method === 'POST') {
        const body = await parseBody(request)
        const { tripId, noteText } = body || {}
        if (!tripId || !noteText?.trim()) return toError('tripId and noteText required', 400)

        const trip = await getTrip(db, tripId)
        if (!trip) return toError('trip not found', 404)
        if (trip.status !== 'active') return toError('trip has ended', 400)

        let parsed = await parseWithAI(env, noteText, trip.currency)
        if (!parsed.length) parsed = parseFallback(noteText, trip.currency)

        const inserted = []
        for (const item of parsed) {
          inserted.push(await insertExpense(db, notebook.notebookId, trip.id, item, noteText, trip.currency))
        }
        return json({ expenses: inserted }, 201)
      }

      if (pathname.startsWith('/api/expenses/') && request.method === 'PATCH') {
        const id = pathId(pathname, '/api/expenses/')
        const body = await parseBody(request)
        const existing = await db.prepare('SELECT * FROM expenses WHERE id = ?').bind(id).first()
        if (!existing) return toError('expense not found', 404)

        const nextMapUrl = body.google_map_url === undefined ? existing.google_map_url : safeText(body.google_map_url) || null
        let nextThumbnail = existing.thumbnail_url
        if (body.google_map_url !== undefined) {
          if (!nextMapUrl) {
            nextThumbnail = null
          } else if (isGoogleMapsUrl(nextMapUrl)) {
            nextThumbnail = await resolveMapThumbnailFromUrl(nextMapUrl)
          } else {
            nextThumbnail = null
          }
        }

        const now = new Date().toISOString()
        await db
          .prepare(
            `UPDATE expenses
             SET amount = ?, currency = ?, category = ?, merchant = ?, note = ?, expense_date = ?, google_map_url = ?, thumbnail_url = ?, updated_at = ?
             WHERE id = ?`,
          )
          .bind(
            Number(body.amount),
            normalizeCurrency(body.currency, existing.currency),
            body.category || existing.category,
            body.merchant ?? existing.merchant,
            body.note ?? existing.note,
            body.expense_date || body.expenseDate || existing.expense_date,
            nextMapUrl,
            nextThumbnail,
            now,
            id,
          )
          .run()

        const updated = await db.prepare('SELECT * FROM expenses WHERE id = ?').bind(id).first()
        return json({ expense: updated })
      }

      if (pathname.startsWith('/api/expenses/') && request.method === 'DELETE') {
        const id = pathId(pathname, '/api/expenses/')
        await db.prepare('DELETE FROM expenses WHERE id = ?').bind(id).run()
        return json({ ok: true })
      }

      return toError('not found', 404)
    } catch (error) {
      return toError(error?.message || 'unexpected error', 500)
    }
  },
}
