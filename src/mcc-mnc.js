// mcc-mnc.js -- MCC/MNC lookup from the mcc-mnc-list package (Wikipedia-sourced, global coverage)
const mccMncList = require('mcc-mnc-list')

// Build an O(1) lookup map at startup.
// Key: "MCC_MNC" where MNC is normalized (leading zeros stripped) to handle both
// stored forms ("50" and "050") mapping to the same key.
// Operational entries are inserted first so they win on duplicate keys.
const byMccMnc = new Map()

const sorted = mccMncList.all().slice().sort((a, b) => {
  if (a.status === 'Operational' && b.status !== 'Operational') return -1
  if (b.status === 'Operational' && a.status !== 'Operational') return 1
  return 0
})

for (const e of sorted) {
  const key = e.mcc + '_' + String(parseInt(e.mnc, 10))
  if (!byMccMnc.has(key)) {
    byMccMnc.set(key, {
      mcc: e.mcc,
      mnc: e.mnc,           // original string from the dataset (may have leading zeros)
      operator: e.brand || e.operator || 'Unknown',
      region: e.countryName || 'Unknown',
    })
  }
}

// Look up a full IMSI (14-15 digit string).
// Tries 3-digit MNC first (Americas), then 2-digit (rest of world).
// Returns {mcc, mnc, operator, region} or null.
// The returned `mnc` is the raw slice from the IMSI (preserves any leading zeros).
function lookupImsi(imsi) {
  if (!imsi || imsi.length < 5) return null
  const mcc = imsi.slice(0, 3)

  if (imsi.length >= 6) {
    const mnc = imsi.slice(3, 6)
    const e = byMccMnc.get(mcc + '_' + String(parseInt(mnc, 10)))
    if (e) return { ...e, mcc, mnc }
  }

  const mnc = imsi.slice(3, 5)
  const e = byMccMnc.get(mcc + '_' + String(parseInt(mnc, 10)))
  return e ? { ...e, mcc, mnc } : null
}

// Look up a prefix string (5 or 6 digit MCC+MNC, e.g. "23450" or "302720").
// Returns {mcc, mnc, operator, region} or null.
function lookupPrefix(prefix) {
  if (!prefix || prefix.length < 5) return null
  const mcc = prefix.slice(0, 3)
  const mnc = prefix.slice(3) // 2 or 3 chars depending on prefix length
  const e = byMccMnc.get(mcc + '_' + String(parseInt(mnc, 10)))
  return e ? { ...e, mcc, mnc } : null
}

module.exports = { lookupImsi, lookupPrefix }
