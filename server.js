// dispatcher/server.js – HP Trader Engine v9.1 | Full-Featured Admin Dashboard (Upgraded)
const express = require('express');
const axios = require('axios');
const mongoose = require('mongoose');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const { ChartJSNodeCanvas } = require('chartjs-node-canvas');
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// ── Environment ─────────────────────────────────────────────────────────────
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK;
const ADMIN_USER = process.env.ADMIN_USER;
const ADMIN_PASS = process.env.ADMIN_PASS;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/alpha_engine';
const BRAIN_APP_URL = process.env.BRAIN_APP_URL || 'http://localhost:7860';
const SIGNAL_API_KEY = process.env.SIGNAL_API_KEY || '';

if (!ADMIN_USER || !ADMIN_PASS) {
  console.error('ADMIN_USER və ADMIN_PASS mühit dəyişənləri təyin olunmalıdır');
  process.exit(1);
}

let lastSignal = null;
const SEND_REJECTED_TELEGRAM = true;
const DISCORD_ENABLED = true;
const SEND_REJECTED_DISCORD = true;

// ── Chart renderer (for Telegram inline charts) ─────────────────────────────
const chartCanvas = new ChartJSNodeCanvas({
  width: 600,
  height: 300,
  backgroundColour: '#0d1117',
});

// ── MongoDB bağlantısı ──────────────────────────────────────────────────────
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB bağlandı'))
  .catch(err => console.error('❌ MongoDB bağlantı xətası:', err.message));

const signalSchema = new mongoose.Schema({
  asset: String,
  direction: String,
  status: String,
  strength: { type: String, default: 'NORMAL' },
  entry: Number,
  tp1: Number,
  sl1: Number,
  tp2: Number,
  sl2: Number,
  confidence: Number,
  strategy: String,
  reason: String,
  rationale: String,
  metrics: Object,
  timestamp: Date,
  receivedAt: { type: Date, default: Date.now },
  netProfit: { type: Number, default: null },
  outcome: { type:String, default: null }, // 'WIN','LOSS','TIME_STOP'
  exitPrice: { type: Number, default: null },
  exitTime: { type: Date, default: null },
  trailing: Object,
  predicted_edge: Number,
  regime: String,
  session: String,
}, { collection: 'signals' });
const Signal = mongoose.model('Signal', signalSchema);

// ── Proqnoz Dəqiqliyi sxemi ────────────────────────────────────────────────
const predictionAccuracySchema = new mongoose.Schema({
  timestamp: { type: Date, default: Date.now },
  asset: { type: String, default: 'ALL' },
  n_pairs: { type: Number, required: true },
  pearson_r: { type: Number, default: null },
  spearman_r: { type: Number, default: null },
  r_squared: { type: Number, default: null },
  slope: { type: Number, default: null },
  intercept: { type: Number, default: null },
  mean_predicted: { type: Number, default: null },
  mean_actual: { type: Number, default: null },
  cycle_count: { type: Number, default: 0 },
}, { collection: 'prediction_accuracy' });
const PredictionAccuracy = mongoose.model('PredictionAccuracy', predictionAccuracySchema);

// ── Model Performans sxemi ────────────────────────────────────────────────
const modelPerformanceSchema = new mongoose.Schema({
  timestamp: { type: Date, default: Date.now },
  asset: String,
  model_name: String,
  sharpe: Number,
  profit_factor: Number,
  sortino: Number,
  mae: Number,
  rmse: Number,
  direction_accuracy: Number,
  walk_forward_days: Number,
}, { collection: 'model_performance' });
const ModelPerformance = mongoose.model('ModelPerformance', modelPerformanceSchema);

// ── İstifadəçi rəyi sxemi ─────────────────────────────────────────────────
const feedbackSchema = new mongoose.Schema({
  action: String,
  asset: String,
  direction: String,
  entry: String,
  timestamp: { type: Date, default: Date.now }
}, { collection: 'user_feedback' });
const Feedback = mongoose.model('Feedback', feedbackSchema);

// ── Admin session idarəsi ──────────────────────────────────────────────────
let adminAuthToken = null;
const TOKEN_EXPIRY = 24 * 60 * 60 * 1000; // 24 saat

// ─── Köməkçi funksiyalar ────────────────────────────────────────────────────
function escapeHtml(str) {
  if (str === undefined || str === null) return '—';
  const s = String(str);
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatNumber(v, decimals = null) {
  if (v === undefined || v === null) return '—';
  const num = Number(v);
  if (isNaN(num)) return escapeHtml(String(v));
  if (decimals !== null) return num.toFixed(decimals);
  if (Math.abs(num) > 10000) return num.toFixed(3);
  if (Math.abs(num) > 100) return num.toFixed(4);
  if (Math.abs(num) > 1) return num.toFixed(5);
  return num.toFixed(6);
}

function safeDate(ts) {
  if (ts === null || ts === undefined) return new Date(0);
  const d = new Date(ts);
  return isNaN(d.getTime()) ? new Date(0) : d;
}
function safeISO(ts) { return safeDate(ts).toISOString(); }
function safeTimeString(ts) {
  const d = safeDate(ts);
  if (d.getTime() === 0) return '—';
  try {
    return d.toLocaleString('az-AZ', { timeZone: 'Asia/Baku' });
  } catch (e) {
    return d.toISOString();
  }
}

function closeTelegramTags(text) {
  const openTags = [];
  const tagRe = /<\/?([a-z]+)[^>]*>/gi;
  let m;
  while ((m = tagRe.exec(text)) !== null) {
    if (m[0].startsWith('</')) {
      if (openTags.length && openTags[openTags.length - 1] === m[1].toLowerCase()) {
        openTags.pop();
      }
    } else {
      openTags.push(m[1].toLowerCase());
    }
  }
  return text + openTags.reverse().map(t => `</${t}>`).join('');
}

function renderAuditSection(entries) {
  if (!entries || entries.length === 0) return '  <i>—</i>';
  return entries.map(e => {
    const icon = e.pass ? '✅' : '❌';
    return `  ${icon} <b>${escapeHtml(e.label)}:</b> <code>${escapeHtml(String(e.current))}</code> / ${escapeHtml(String(e.threshold))}`;
  }).join('\n');
}

// ─── Telegram formatlayıcı ─────────────────────────────────────────────────
function formatTelegram(signal) {
  if (signal.direction === 'TEST') {
    const timeStr = safeTimeString(signal.timestamp);
    const rationale = escapeHtml(signal.rationale || 'Connection test successful.');
    let msg = `🧪 <b>SYSTEM TEST</b>\n✅ HP Trader Engine v9.1 is online\n🕒 ${timeStr}\n───────────────────────\n${rationale}`;
    return msg.replace(/<(?!(?:\/)?(?:b|code|i)\b)/gi, '&lt;');
  }

  // ── VIP SIGNAL ──────────────────────────────────────────────────────────
  if (signal.status === 'VIP_SIGNAL') {
    const timeStr = safeTimeString(signal.timestamp);
    const dirIcon = signal.direction === 'BUY' ? '📈' : '📉';
    const badge = signal.direction === 'BUY' ? '🟢 VIP BUY' : '🔴 VIP SELL';
    const assetEsc = escapeHtml(signal.asset);
    const priceEsc = formatNumber(signal.entry, 5);
    const edgePct = signal.predicted_edge != null
      ? (parseFloat(signal.predicted_edge) * 100).toFixed(2) + '%'
      : '—';
    const confEsc = signal.confidence != null ? escapeHtml(signal.confidence + '%') : '—';
    const regimeEsc = escapeHtml(signal.regime || '—');
    const sessionEsc = escapeHtml(signal.session || '—');

    let msg = `👑 <b>VIP SIGNAL: ${assetEsc}</b>  ${badge}\n${dirIcon} Price: <code>${priceEsc}</code>\n───────────────────────\n📊 Proqnoz Kənar: <b>${edgePct}</b>\n🧠 İnam: ${confEsc}\n🌍 Rejim: ${regimeEsc}\n🕒 Vaxt: ${timeStr}\n📍 Sessiya: ${sessionEsc}\n───────────────────────\n⚠️ Bu yüksək keyfiyyətli siqnaldır. Əsas əmr ayrıca göndəriləcək.`;
    return msg.replace(/<(?!(?:\/)?(?:b|code|i)\b)/gi, '&lt;');
  }

  // ── REJECTED ────────────────────────────────────────────────────────────
  if (signal.status === 'REJECTED') {
    const timeStr = safeTimeString(signal.timestamp);
    const m = signal.metrics || {};
    const al = m.audit_log || {};
    const dir = signal.direction ?? '?';
    const dirIcon = dir === 'BUY' ? '📈' : '📉';
    const assetEsc = escapeHtml(signal.asset);
    const reasonEsc = escapeHtml(signal.reason || '—');
    const gateEsc = escapeHtml(m.gate || '—');

    const summaryParts = [];
    if (m.price != null) summaryParts.push(`💰 <code>${formatNumber(m.price, 5)}</code>`);
    if (m.conf != null) summaryParts.push(`📊 Conf: <code>${escapeHtml(m.conf + '%')}</code>`);
    if (m.regime) summaryParts.push(`🌍 ${escapeHtml(m.regime)}`);
    if (m.strategy) summaryParts.push(`📐 ${escapeHtml(m.strategy)}`);
    const summary = summaryParts.join('  ');

    const SECTION_ICONS = {
      CONFIDENCE: '🧠', RSI: '📈', REGIME: '🌍',
      CONFLUENCE: '🔀', META: '🤖', RISK: '⚖️', DEDUP: '⏱️', MTF: '📊', SESSION: '🕐'
    };
    const SECTION_ORDER = ['CONFIDENCE', 'RSI', 'REGIME', 'CONFLUENCE', 'META', 'RISK', 'DEDUP', 'MTF', 'SESSION'];
    const sectionBlocks = SECTION_ORDER
      .filter(sec => al[sec] && al[sec].length > 0)
      .map(sec => {
        const icon = SECTION_ICONS[sec] || '•';
        const entries = al[sec];
        const allPass = entries.every(e => e.pass);
        if (allPass) return `${icon} <b>${escapeHtml(sec)}</b>: ✅ bütün yoxlamalar keçdi`;
        return `${icon} <b>${escapeHtml(sec)}</b>\n${renderAuditSection(entries)}`;
      });
    const auditBody = sectionBlocks.length ? sectionBlocks.join('\n') : `🚪 Gate: ${gateEsc}`;

    let msg = `🚫 <b>FİLTRƏ EDİLDİ: ${assetEsc} (${dirIcon} ${dir})</b>\n${summary}\n🕒 ${timeStr}\n───────────────────────\n🚪 <b>İlk uğursuzluq:</b> ${gateEsc}\n💬 ${reasonEsc}\n───────────────────────\n${auditBody}`;
    return msg.replace(/<(?!(?:\/)?(?:b|code|i)\b)/gi, '&lt;');
  }

  // ── SUCCESS ─────────────────────────────────────────────────────────────
  const strength = signal.strength === 'STRONG' ? 'STRONG ' : '';
  const arrow = signal.direction === 'BUY' ? '📈' : '📉';
  const badge = signal.direction === 'BUY' ? `🟢 ${strength}BUY` : `🔴 ${strength}SELL`;

  const assetEsc = escapeHtml(signal.asset);
  const entryEsc = formatNumber(signal.entry, 5);
  const tp1Esc = formatNumber(signal.tp1, 5);
  const tp2Esc = formatNumber(signal.tp2, 5);
  const sl1Esc = formatNumber(signal.sl1, 5);
  const sl2Esc = formatNumber(signal.sl2, 5);
  const confEsc = signal.confidence != null ? escapeHtml(signal.confidence + '%') : '—';

  // TP Ehtimal Zonaları
  const probTp1 = signal.metrics?.prob_tp1;
  const probTp2 = signal.metrics?.prob_tp2;
  let probText = '';
  if (probTp1 != null && probTp2 != null) {
    probText = `\n📊 <b>TP Ehtimalları:</b> TP1 ~${probTp1}%  |  TP2 ~${probTp2}%`;
  }

  // Xəbər Xəbərdarlığı
  const newsWarn = signal.metrics?.news_warning;
  const newsWarnText = newsWarn ? `\n⚠️ <b>YAXIN XƏBƏR:</b> ${escapeHtml(newsWarn)}` : '';

  const rationaleEsc = escapeHtml(signal.rationale || '—');
  const timeStr = safeTimeString(signal.timestamp);

  const m = signal.metrics || {};
  const al = m.audit_log || {};
  const SECTION_ICONS = {
    CONFIDENCE: '🧠', RSI: '📈', REGIME: '🌍',
    CONFLUENCE: '🔀', META: '🤖', RISK: '⚖️', DEDUP: '⏱️', MTF: '📊', SESSION: '🕐'
  };
  const SECTION_ORDER = ['CONFIDENCE', 'RSI', 'REGIME', 'CONFLUENCE', 'META', 'RISK', 'DEDUP', 'MTF', 'SESSION'];
  const sectionBlocks = SECTION_ORDER
    .filter(sec => al[sec] && al[sec].length > 0)
    .map(sec => {
      const icon = SECTION_ICONS[sec] || '•';
      const entries = al[sec];
      const allPass = entries.every(e => e.pass);
      if (allPass) return `${icon} <b>${escapeHtml(sec)}</b>: ✅ bütün yoxlamalar keçdi`;
      return `${icon} <b>${escapeHtml(sec)}</b>\n${renderAuditSection(entries)}`;
    });
  const auditBody = sectionBlocks.length ? sectionBlocks.join('\n') : '';

  // Risk Skoru
  const riskScore = signal.metrics?.risk_score;
  let riskBar = '';
  if (riskScore != null) {
    const filled = Math.round(riskScore / 10);
    const empty = 10 - filled;
    riskBar = `\n🛡️ <b>Risk Skoru:</b> ${riskScore}/100  [${'█'.repeat(filled)}${'░'.repeat(empty)}]`;
  }

  // Siqnal Yaşı
  const nowTs = Date.now();
  const sigTs = safeDate(signal.timestamp).getTime();
  const ageSec = (nowTs - sigTs) / 1000;
  let ageIcon, ageText;
  if (ageSec < 60) { ageIcon = '🟢'; ageText = 'Təzə (<1 dəq)'; }
  else if (ageSec < 300) { ageIcon = '🟡'; ageText = `Orta (${Math.round(ageSec / 60)} dəq)`; }
  else { ageIcon = '🔴'; ageText = `Köhnə (${Math.round(ageSec / 60)} dəq)`; }

  // Market Context
  const mc = signal.metrics?.market_context;
  const mcText = mc ? `\n📈 <b>Market Context:</b> ${escapeHtml(mc)}` : '';

  // Ardıcıl Siqnal Sayğacı
  const consec = signal.metrics?.consec_24h;
  const consecText = consec && consec > 1 ? `\n⏱️ Son 24 saatda ${escapeHtml(signal.asset)} ${escapeHtml(signal.direction)}: ${consec} siqnal` : '';

  // Trailing stop məlumatı
  let trailText = '';
  if (signal.trailing) {
    trailText = `\n📏 <b>Trailing Stop:</b> aktivləşmə @${formatNumber(signal.trailing.activate_at, 5)}, məsafə=${formatNumber(signal.trailing.distance, 5)}`;
  }

  // 📊 Qrafik gələcək (ayrıca mesaj kimi)
  const chartNote = '\n📈 <i>Qrafik ayrı mesaj kimi göndəriləcək</i>';

  let msg = `🚨 <b>ALPHA SIGNAL: ${assetEsc}</b>  ${badge}\n${arrow} Giriş: <code>${entryEsc}</code>\n──── TP / SL ────────────\n🎯 TP1: <code>${tp1Esc}</code>   TP2: <code>${tp2Esc}</code>\n🛡️ ${escapeHtml(signal.sl_used || 'SL1')}: <code>${sl1Esc}</code>   SL2: <code>${sl2Esc}</code>\n───────────────────────\n📊 İnam: ${confEsc}${probText}${newsWarnText}${riskBar}${mcText}${consecText}${trailText}\n🧠 Səbəb: ${rationaleEsc}\n🕒 ${timeStr}  ${ageIcon} ${ageText}${chartNote}\n${auditBody ? '───────────────────────\n' + auditBody : ''}`;

  return msg.replace(/<(?!(?:\/)?(?:b|code|i)\b)/gi, '&lt;');
}

// ─── Discord embed qurucusu ────────────────────────────────────────────────
function buildDiscordEmbed(signal) {
  if (signal.direction === 'TEST') {
    return {
      title: '🧪 SYSTEM TEST – HP Trader Engine v9.1',
      description: signal.rationale || 'Connection test successful.',
      color: 0x3498db,
      timestamp: safeISO(signal.timestamp),
    };
  }

  if (signal.status === 'VIP_SIGNAL') {
    const edgePct = signal.predicted_edge != null
      ? (parseFloat(signal.predicted_edge) * 100).toFixed(2) + '%'
      : '—';
    return {
      title: `👑 VIP ${signal.direction} – ${signal.asset}`,
      description: `**Proqnoz Kənar: ${edgePct}**\n⚠️ Yüksək keyfiyyətli siqnal – əsas əmr ayrıca gələcək.`,
      color: 0xf1c40f,
      fields: [
        { name: 'Qiymət', value: `\`${formatNumber(signal.entry, 5)}\``, inline: true },
        { name: 'İnam', value: `${signal.confidence}%`, inline: true },
        { name: 'Rejim', value: signal.regime || '—', inline: true },
        { name: 'Sessiya', value: signal.session || '—', inline: true },
      ],
      footer: { text: 'Alpha Engine v9.1 – VIP Alert' },
      timestamp: safeISO(signal.timestamp),
    };
  }

  if (signal.status === 'REJECTED' && signal.metrics?.gate === 'MODEL_HEALTH') {
    const reasonEsc = escapeHtml(signal.reason || 'Model performansı pisləşdi');
    return {
      title: '⚠️ MODEL SAĞLAMLIĞI XƏBƏRDARLIĞI',
      description: reasonEsc,
      color: 0xe67e22,
      footer: { text: 'Əl ilə riski azaldın, siqnalları filtrdən keçirin.' },
      timestamp: safeISO(signal.timestamp),
    };
  }

  if (signal.status === 'REJECTED') {
    const m = signal.metrics || {};
    const al = m.audit_log || {};
    const dir = signal.direction ?? '?';
    const SECTION_ORDER = ['CONFIDENCE', 'RSI', 'REGIME', 'CONFLUENCE', 'META', 'RISK', 'DEDUP', 'MTF', 'SESSION'];
    const fields = [
      { name: '🔍 İlk Uğursuzluq', value: `\`${m.gate ?? '—'}\``, inline: true },
      { name: '📊 İnam', value: `${m.conf ?? '—'}%`, inline: true },
      { name: '🌍 Rejim', value: m.regime ?? '—', inline: true },
    ];
    SECTION_ORDER.forEach(sec => {
      const entries = al[sec];
      if (!entries || entries.length === 0) return;
      const lines = entries.map(e => `${e.pass ? '✅' : '❌'} ${e.label}: \`${String(e.current)}\` / ${e.threshold}`);
      fields.push({ name: sec, value: lines.join('\n').slice(0, 1024), inline: false });
    });
    return {
      title: `🚫 FİLTRƏ EDİLDİ – ${signal.asset} (${dir})`,
      description: signal.reason || '—',
      color: 0x607d8b,
      fields,
      footer: { text: `Strategiya: ${signal.strategy || '—'}  |  Qiymət: ${m.price ?? '—'}` },
      timestamp: safeISO(signal.timestamp),
    };
  }

  // SUCCESS
  const strength = signal.strength === 'STRONG' ? 'STRONG ' : '';
  const color = signal.direction === 'BUY' ? 0x00e676 : 0xff5252;

  const m = signal.metrics || {};
  const al = m.audit_log || {};
  const SECTION_ORDER = ['CONFIDENCE', 'RSI', 'REGIME', 'CONFLUENCE', 'META', 'RISK', 'DEDUP', 'MTF', 'SESSION'];
  const auditFields = [];
  SECTION_ORDER.forEach(sec => {
    const entries = al[sec];
    if (!entries || entries.length === 0) return;
    const lines = entries.map(e => `${e.pass ? '✅' : '❌'} ${e.label}: \`${String(e.current)}\` / ${e.threshold}`);
    auditFields.push({ name: sec, value: lines.join('\n').slice(0, 1024), inline: false });
  });

  // TP ehtimalları
  const probFields = [];
  if (m.prob_tp1 != null) probFields.push({ name: '🎯 TP1 Ehtimalı', value: `~${m.prob_tp1}%`, inline: true });
  if (m.prob_tp2 != null) probFields.push({ name: '🎯 TP2 Ehtimalı', value: `~${m.prob_tp2}%`, inline: true });

  // Risk skoru
  if (m.risk_score != null) probFields.push({ name: '🛡️ Risk Skoru', value: `${m.risk_score}/100`, inline: true });

  return {
    title: `${signal.direction === 'BUY' ? '🟢 ' + strength + 'BUY' : '🔴 ' + strength + 'SELL'}  –  ${signal.asset}`,
    color,
    fields: [
      { name: 'Giriş', value: `\`${formatNumber(signal.entry, 5)}\``, inline: true },
      { name: 'İnam', value: `${signal.confidence}%`, inline: true },
      ...probFields,
      { name: '\u200B', value: '\u200B', inline: false },
      { name: '🎯 TP1', value: `\`${formatNumber(signal.tp1, 5)}\``, inline: true },
      { name: '🎯 TP2', value: `\`${formatNumber(signal.tp2, 5)}\``, inline: true },
      { name: '\u200B', value: '\u200B', inline: false },
      { name: `🛡️ ${signal.sl_used || 'SL1'}`, value: `\`${formatNumber(signal.sl1, 5)}\``, inline: true },
      { name: '🛡️ SL2', value: `\`${formatNumber(signal.sl2, 5)}\``, inline: true },
      ...(signal.trailing ? [{ name: '📏 Trailing Stop', value: `Aktivləşmə: \`${formatNumber(signal.trailing.activate_at, 5)}\`\nMəsafə: \`${formatNumber(signal.trailing.distance, 5)}\``, inline: false }] : []),
      ...(auditFields.length > 0 ? [{ name: '\u200B', value: '**Audit Log**', inline: false }, ...auditFields] : [])
    ],
    footer: { text: signal.rationale || '' },
    timestamp: safeISO(signal.timestamp),
  };
}

// ─── Telegram göndərici ─────────────────────────────────────────────────────
const MAX_TG_LEN = 4000;
async function sendTelegramWithRetry(msg, asset, retries = 3, delay = 1000, signal = null) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return false;
  if (msg.length > MAX_TG_LEN) {
    console.warn(`⚠️ Telegram mesajı çox uzun (${msg.length}), qısaldılır... (${asset})`);
    const truncated = msg.slice(0, MAX_TG_LEN - 80) + "\n\n... (kəsildi)";
    msg = closeTelegramTags(truncated);
  }
  for (let i = 0; i < retries; i++) {
    try {
      let replyMarkup = undefined;
      if (signal && signal.status === 'SUCCESS') {
        replyMarkup = {
          inline_keyboard: [[
            { text: '✅ İcra etdim', callback_data: `executed:${signal.asset}:${signal.direction}:${signal.entry}` },
            { text: '❌ İmtina etdim', callback_data: `rejected:${signal.asset}:${signal.direction}:${signal.entry}` },
            { text: '⏰ Gecikdim', callback_data: `late:${signal.asset}:${signal.direction}:${signal.entry}` }
          ]]
        };
      }

      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
        chat_id: TELEGRAM_CHAT_ID,
        text: msg,
        parse_mode: 'HTML',
        reply_markup: replyMarkup
      }, { timeout: 10000 });
      console.log(`✅ Telegram OK (${asset})`);
      return true;
    } catch (error) {
      const isLast = i === retries - 1;
      console.error(`❌ Telegram cəhd ${i + 1}/${retries} uğursuz (${asset})`, error.response?.data?.description || error.message);
      if (isLast) return false;
      await new Promise(resolve => setTimeout(resolve, delay * Math.pow(2, i)));
    }
  }
  return false;
}

async function sendTelegram(msg, asset = 'unknown', signal = null) {
  return sendTelegramWithRetry(msg, asset, 3, 1000, signal);
}

// ─── Qrafik generasiya və Telegram-a göndərmə ────────────────────────────
async function generateChartImage(closePrices, entry, tp1, sl1, direction) {
  const labels = Array.from({ length: closePrices.length }, (_, i) => i);
  const data = {
    labels,
    datasets: [{
      label: 'Close',
      data: closePrices,
      borderColor: '#ffffff',
      backgroundColor: 'transparent',
      pointRadius: 0,
      borderWidth: 1.2,
    }]
  };

  const annotationLines = {};
  if (entry != null) {
    // Giriş xətti
  }

  const configuration = {
    type: 'line',
    data,
    options: {
      scales: {
        x: { display: false },
        y: { ticks: { color: '#8b949e' }, grid: { color: '#21262d' } }
      },
      plugins: {
        legend: { display: false },
        annotation: {
          annotations: {
            entryLine: entry != null ? {
              type: 'line',
              yMin: entry,
              yMax: entry,
              borderColor: '#58a6ff',
              borderWidth: 1,
              borderDash: [5, 5],
              label: { content: `Giriş ${entry}`, display: true, position: 'start', color: '#58a6ff' }
            } : undefined,
            tp1Line: tp1 != null ? {
              type: 'line',
              yMin: tp1,
              yMax: tp1,
              borderColor: '#00e676',
              borderWidth: 1,
              borderDash: [5, 5],
              label: { content: `TP1 ${tp1}`, display: true, position: 'start', color: '#00e676' }
            } : undefined,
            sl1Line: sl1 != null ? {
              type: 'line',
              yMin: sl1,
              yMax: sl1,
              borderColor: '#ff5252',
              borderWidth: 1,
              borderDash: [5, 5],
              label: { content: `SL1 ${sl1}`, display: true, position: 'start', color: '#ff5252' }
            } : undefined,
          }
        }
      }
    }
  };

  try {
    const imageBuffer = await chartCanvas.renderToBuffer(configuration);
    return imageBuffer;
  } catch (error) {
    console.error('Qrafik generasiya xətası:', error.message);
    return null;
  }
}

async function sendTelegramChart(signal) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID || !signal.metrics?.close_prices) return false;
  try {
    const closePrices = signal.metrics.close_prices;
    const imageBuffer = await generateChartImage(
      closePrices, signal.entry, signal.tp1, signal.sl1, signal.direction
    );
    if (!imageBuffer) return false;

    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendPhoto`;
    const formData = new FormData();
    formData.append('chat_id', TELEGRAM_CHAT_ID);
    formData.append('photo', new Blob([imageBuffer], { type: 'image/png' }), 'chart.png');
    formData.append('caption', `📈 ${signal.asset} ${signal.direction} qrafiki`);

    await axios.post(url, formData, { timeout: 15000, headers: { 'Content-Type': 'multipart/form-data' } });
    console.log(`✅ Telegram qrafik göndərildi (${signal.asset})`);
    return true;
  } catch (error) {
    console.error(`❌ Telegram qrafik göndərmə xətası (${signal.asset}):`, error.message);
    return false;
  }
}

// ─── Discord göndərici ──────────────────────────────────────────────────────
async function sendDiscord(signal) {
  if (!DISCORD_WEBHOOK) return false;
  try {
    await axios.post(DISCORD_WEBHOOK, { embeds: [buildDiscordEmbed(signal)] }, { timeout: 10000 });
    console.log('✅ Discord OK');
    return true;
  } catch (error) {
    console.error('❌ Discord FAILED', error.message);
    return false;
  }
}

// ─── Əsas göndərmə ──────────────────────────────────────────────────────────
async function dispatchSignal(signal) {
  const msg = formatTelegram(signal);
  const asset = signal.asset || 'unknown';

  const sendTg = signal.status !== 'REJECTED' || SEND_REJECTED_TELEGRAM;
  if (TELEGRAM_TOKEN && TELEGRAM_CHAT_ID && sendTg) {
    await sendTelegram(msg, asset, signal);
    // SUCCESS siqnalları üçün qrafik göndər
    if (signal.status === 'SUCCESS' && signal.metrics?.close_prices) {
      await sendTelegramChart(signal);
    }
  }

  const sendDc = signal.status !== 'REJECTED' || SEND_REJECTED_DISCORD;
  if (DISCORD_WEBHOOK && DISCORD_ENABLED && sendDc) {
    await sendDiscord(signal);
  }
}

// ─── Startup öz-testi ────────────────────────────────────────────────────────
async function startupTest() {
  console.log('🔧 Startup öz-testi işə salınır...');
  const testSignal = {
    asset: 'SYSTEM',
    direction: 'TEST',
    entry: 0, tp1: 0, tp2: 0, sl1: 0, sl2: 0,
    confidence: 0,
    rationale: 'Dispatcher self-test – HP Trader Engine v9.1',
    timestamp: new Date().toISOString(),
  };
  await dispatchSignal(testSignal);
  console.log('🔧 Startup öz-testi tamamlandı.');
}

// ── Session auth middleware ─────────────────────────────────────────────────
function sessionAuth(req, res, next) {
  const token = req.cookies.admin_token;
  if (!token || !adminAuthToken) {
    res.clearCookie('admin_token');
    return res.redirect(`/login?redirect=${encodeURIComponent(req.originalUrl)}`);
  }
  if (Date.now() > adminAuthToken.expires) {
    adminAuthToken = null;
    res.clearCookie('admin_token');
    return res.redirect(`/login?redirect=${encodeURIComponent(req.originalUrl)}`);
  }
  const incomingBuf = Buffer.from(token, 'hex');
  const expectedBuf = Buffer.from(adminAuthToken.token, 'hex');
  const lengthMatch = incomingBuf.length === expectedBuf.length;
  const safeIncoming = lengthMatch ? incomingBuf : Buffer.alloc(expectedBuf.length);
  if (!lengthMatch || !crypto.timingSafeEqual(safeIncoming, expectedBuf)) {
    res.clearCookie('admin_token');
    return res.redirect(`/login?redirect=${encodeURIComponent(req.originalUrl)}`);
  }
  next();
}

// ═════════════════════════════════════════════════════════════════════════════
// Routes
// ═════════════════════════════════════════════════════════════════════════════

// ── /signal (POST) ─────────────────────────────────────────────────────────
app.post('/signal', async (req, res) => {
  if (SIGNAL_API_KEY) {
    const incomingKey = req.headers['x-api-key'] || '';
    if (incomingKey !== SIGNAL_API_KEY) {
      console.error(`❌ /signal: səlahiyyətsiz sorğu`);
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }
  const signal = req.body;

  const isVip = signal.status === 'VIP_SIGNAL';
  const isSuccess = !isVip && (signal.status === 'SUCCESS' || (!signal.status && signal.direction !== 'TEST'));
  if (isSuccess && (signal.entry == null || signal.tp1 == null || signal.sl1 == null)) {
    console.error(`❌ [BLOKLANDI] ${signal.asset} üçün boş ticarət dəyərləri`);
    return res.status(200).json({ blocked: true, reason: 'Qiymət sahələri çatışmır' });
  }

  lastSignal = signal;

  if (!signal.skip_db) {
    try {
      let safeTimestamp;
      if (signal.timestamp) {
        const parsed = new Date(signal.timestamp);
        safeTimestamp = isNaN(parsed.getTime()) ? new Date() : parsed;
      } else {
        safeTimestamp = new Date();
      }

      await Signal.create({
        asset: signal.asset,
        direction: signal.direction,
        status: isVip ? 'VIP_SIGNAL' : (signal.status || null),
        strength: signal.strength || 'NORMAL',
        entry: signal.entry ?? 0,
        tp1: signal.tp1 ?? 0,
        sl1: signal.sl1 ?? 0,
        tp2: signal.tp2 ?? null,
        sl2: signal.sl2 ?? null,
        confidence: signal.confidence ?? 0,
        strategy: signal.strategy || null,
        reason: signal.reason || null,
        rationale: signal.rationale || null,
        metrics: signal.metrics || null,
        timestamp: safeTimestamp,
        trailing: signal.trailing || null,
        predicted_edge: signal.predicted_edge || null,
        regime: signal.regime || null,
        session: signal.session || null,
      });
      console.log(`✅ MongoDB yazıldı: ${signal.asset} (${isVip ? 'VIP_SIGNAL' : signal.status})`);
    } catch (err) {
      console.error('❌ MongoDB yazma xətası:', err.message);
      console.error('   Problemli siqnal:', JSON.stringify(signal).slice(0, 500));
    }
  } else {
    console.log(`📨 [SKIP_DB] ${signal.status ?? signal.direction} | ${signal.asset} | ${signal.direction}`);
  }

  const displayStatus = isVip ? '⭐VIP' : (signal.status ?? signal.direction);
  console.log(`📥 ${displayStatus} | ${signal.asset} | ${signal.direction} | ${new Date().toISOString()}`);

  dispatchSignal(signal);
  res.sendStatus(200);
});

// ── /health – AÇIQ ─────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    lastSignal: lastSignal ? `${lastSignal.asset} ${lastSignal.direction} (${lastSignal.status ?? 'legacy'})` : 'none',
  });
});

// ── /login – GET ───────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  const redirect = req.query.redirect || '/admin';
  res.send(`<!DOCTYPE html>
<html lang="az">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>HP Trader Engine v9.1 – Giriş</title>
  <style>
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family:system-ui, sans-serif; background:#0d1117; color:#c9d1d9;
           display:flex; align-items:center; justify-content:center; height:100vh; }
    .login-box { background:#161b22; padding:2rem; border-radius:8px; width:320px; }
    h2 { text-align:center; margin-bottom:1.5rem; }
    input { width:100%; padding:10px; margin-bottom:1rem; border:1px solid #30363d;
            background:#0d1117; color:#c9d1d9; border-radius:4px; }
    button { width:100%; padding:10px; background:#238636; color:white; border:none;
             border-radius:4px; cursor:pointer; font-weight:bold; }
    button:hover { background:#2ea043; }
    .error { color: #ff5252; margin-bottom:1rem; text-align:center; }
  </style>
</head>
<body>
  <div class="login-box">
    <h2>🔐 Admin Girişi</h2>
    ${req.query.error ? `<div class="error">${escapeHtml(req.query.error)}</div>` : ''}
    <form method="POST" action="/login">
      <input type="hidden" name="redirect" value="${escapeHtml(redirect)}" />
      <input type="text" name="username" placeholder="İstifadəçi adı" required autofocus />
      <input type="password" name="password" placeholder="Parol" required />
      <button type="submit">Daxil ol</button>
    </form>
  </div>
</body>
</html>`);
});

// ── /login POST ────────────────────────────────────────────────────────────
app.post('/login', (req, res) => {
  const { username, password, redirect } = req.body;
  const safeRedirect = (redirect && /^\/[^/]/.test(redirect)) ? redirect : '/admin';
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    const token = crypto.randomBytes(32).toString('hex');
    adminAuthToken = { token, expires: Date.now() + TOKEN_EXPIRY };
    res.cookie('admin_token', token, {
      httpOnly: true, secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict', maxAge: TOKEN_EXPIRY
    });
    return res.redirect(safeRedirect);
  }
  res.redirect(`/login?error=${encodeURIComponent('İstifadəçi adı və ya parol yanlışdır')}&redirect=${encodeURIComponent(safeRedirect)}`);
});

// ── /logout ────────────────────────────────────────────────────────────────
app.get('/logout', (req, res) => {
  adminAuthToken = null;
  res.clearCookie('admin_token');
  res.redirect('/login');
});

// ── PUT /signal/:id/netProfit ──────────────────────────────────────────────
app.put('/signal/:id/netProfit', sessionAuth, async (req, res) => {
  const { id } = req.params;
  const { netProfit } = req.body;
  if (netProfit === undefined || netProfit === null) {
    return res.status(400).json({ error: 'netProfit tələb olunur' });
  }
  try {
    await Signal.findByIdAndUpdate(id, { netProfit: parseFloat(netProfit) });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /signal/:id/outcome (BRAIN_APP tərəfindən çağrılır) ──────────────
app.put('/signal/:id/outcome', async (req, res) => {
  if (SIGNAL_API_KEY) {
    const incomingKey = req.headers['x-api-key'] || '';
    if (incomingKey !== SIGNAL_API_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }
  const { id } = req.params;
  const { outcome, exitPrice, netProfit } = req.body;
  try {
    const update = { outcome, exitPrice: exitPrice ?? null, netProfit: netProfit ?? null, exitTime: new Date() };
    await Signal.findByIdAndUpdate(id, update);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /signals – Seçilmiş siqnalları sil ──────────────────────────────
app.delete('/signals', sessionAuth, async (req, res) => {
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids array required' });
  }
  try {
    const result = await Signal.deleteMany({ _id: { $in: ids } });
    res.json({ success: true, deletedCount: result.deletedCount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /signal/:id ─────────────────────────────────────────────────────
app.delete('/signal/:id', sessionAuth, async (req, res) => {
  const { id } = req.params;
  try {
    const result = await Signal.findByIdAndDelete(id);
    if (!result) return res.status(404).json({ error: 'Signal not found' });
    res.json({ success: true, deleted: id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── /api/stats – Performans xülasəsi ────────────────────────────────────────
app.get('/api/stats', sessionAuth, async (req, res) => {
  try {
    const totalSuccess = await Signal.countDocuments({ status: 'SUCCESS' });
    const totalRejected = await Signal.countDocuments({ status: 'REJECTED' });
    const totalVip = await Signal.countDocuments({ status: 'VIP_SIGNAL' });

    const profitResult = await Signal.aggregate([
      { $match: { netProfit: { $ne: null } } },
      {
        $group: {
          _id: null, total: { $sum: '$netProfit' },
          wins: { $sum: { $cond: [{ $gte: ['$netProfit', 0] }, 1, 0] } },
          losses: { $sum: { $cond: [{ $lt: ['$netProfit', 0] }, 1, 0] } }
        }
      }
    ]);
    const profit = profitResult[0] || { total: 0, wins: 0, losses: 0 };

    // Gate tezliyi
    const gateAgg = await Signal.aggregate([
      { $match: { status: 'REJECTED' } },
      { $group: { _id: '$metrics.gate', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);

    // Asset üzrə bölgü
    const assetBreakdown = await Signal.aggregate([
      { $match: { status: { $in: ['SUCCESS', 'REJECTED'] } } },
      {
        $group: {
          _id: { asset: '$asset', status: '$status' },
          count: { $sum: 1 },
          totalProfit: { $sum: { $ifNull: ['$netProfit', 0] } },
        }
      },
    ]);

    res.json({
      summary: {
        totalSuccess,
        totalRejected,
        totalVip,
        passRate: totalSuccess + totalRejected > 0
          ? ((totalSuccess / (totalSuccess + totalRejected)) * 100).toFixed(1) + '%'
          : '—',
        netProfit: profit.total.toFixed(2),
        recordedWins: profit.wins,
        recordedLosses: profit.losses,
        winRate: profit.wins + profit.losses > 0
          ? ((profit.wins / (profit.wins + profit.losses)) * 100).toFixed(1) + '%'
          : '—',
      },
      gateFrequency: gateAgg.map(g => ({ gate: g._id || 'UNKNOWN', count: g.count })),
      assetBreakdown,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// Prediction Accuracy API endpoints
// ═════════════════════════════════════════════════════════════════════════════

app.get('/api/prediction-accuracy', sessionAuth, async (req, res) => {
  try {
    const asset = req.query.asset || 'ALL';
    const limit = parseInt(req.query.limit) || 50;
    const from = req.query.from ? new Date(req.query.from) : null;
    const to = req.query.to ? new Date(req.query.to) : null;

    const filter = {};
    if (asset !== 'ALL') filter.asset = asset;
    if (from || to) {
      filter.timestamp = {};
      if (from) filter.timestamp.$gte = from;
      if (to) filter.timestamp.$lte = to;
    }

    const records = await PredictionAccuracy.find(filter)
      .sort({ timestamp: -1 })
      .limit(limit)
      .lean();

    const formatted = records.map(r => ({
      ...r,
      timestamp: r.timestamp.toISOString(),
    })).reverse();

    res.json({ asset, count: formatted.length, records: formatted });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/prediction-accuracy', async (req, res) => {
  if (SIGNAL_API_KEY) {
    const incomingKey = req.headers['x-api-key'] || '';
    if (incomingKey !== SIGNAL_API_KEY) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  try {
    const {
      asset, n_pairs, pearson_r, spearman_r,
      r_squared, slope, intercept,
      mean_predicted, mean_actual, cycle_count,
    } = req.body;

    if (n_pairs === undefined) {
      return res.status(400).json({ error: 'n_pairs required' });
    }

    const record = await PredictionAccuracy.create({
      asset: asset || 'ALL',
      n_pairs,
      pearson_r: pearson_r ?? null,
      spearman_r: spearman_r ?? null,
      r_squared: r_squared ?? null,
      slope: slope ?? null,
      intercept: intercept ?? null,
      mean_predicted: mean_predicted ?? null,
      mean_actual: mean_actual ?? null,
      cycle_count: cycle_count ?? 0,
      timestamp: new Date(),
    });

    console.log(
      `📊 [PredAcc] ${asset || 'ALL'} | n=${n_pairs} | ` +
      `Pearson=${pearson_r?.toFixed(3) ?? '—'} | R²=${r_squared?.toFixed(3) ?? '—'}`
    );

    res.status(201).json({ success: true, id: record._id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/prediction-accuracy/chart', sessionAuth, async (req, res) => {
  try {
    const asset = req.query.asset || 'ALL';
    const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 90 * 86400000);
    const to = req.query.to ? new Date(req.query.to) : new Date();

    const filter = {
      timestamp: { $gte: from, $lte: to },
    };
    if (asset !== 'ALL') filter.asset = asset;

    const records = await PredictionAccuracy.find(filter)
      .sort({ timestamp: 1 })
      .select('timestamp pearson_r spearman_r r_squared slope n_pairs mean_predicted mean_actual')
      .lean();

    const labels = records.map(r => r.timestamp.toISOString().slice(0, 16).replace('T', ' '));
    const chartData = {
      labels,
      pearson_r: records.map(r => r.pearson_r),
      spearman_r: records.map(r => r.spearman_r),
      r_squared: records.map(r => r.r_squared),
      slope: records.map(r => r.slope),
      n_pairs: records.map(r => r.n_pairs),
    };

    res.json({ asset, from, to, count: records.length, chartData });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── /api/proxy/model-performance – Brain_app-dən məlumatı çəkir ────────
app.get('/api/proxy/model-performance', sessionAuth, async (req, res) => {
  try {
    const asset = req.query.asset || '';
    const resp = await axios.get(`${BRAIN_APP_URL}/api/model-performance?asset=${encodeURIComponent(asset)}`, {
      timeout: 5000,
      headers: { 'x-api-key': process.env.READ_API_KEY || '' }
    });
    res.json(resp.data);
  } catch (err) {
    console.error('Model performance proxy error:', err.message);
    res.status(502).json({ error: 'Upstream service unavailable' });
  }
});

// ── /telegram-webhook – Callback Query qəbulu ───────────────────────────
app.post('/telegram-webhook', async (req, res) => {
  const callback = req.body.callback_query;
  if (!callback || !callback.data) {
    return res.sendStatus(200);
  }

  const data = callback.data;
  const parts = data.split(':');
  const action = parts[0];
  const asset = parts[1] || '?';
  const direction = parts[2] || '?';
  const entry = parts[3] || '?';

  try {
    await Feedback.create({ action, asset, direction, entry });
    console.log(`📝 Rəy: ${action} ${asset} ${direction} @ ${entry}`);
  } catch (err) {
    console.error('Rəy yazıla bilmədi:', err.message);
  }

  try {
    const answer = {
      callback_query_id: callback.id,
      text: `Rəyiniz qeyd edildi: ${action === 'executed' ? '✅ İcra' : action === 'rejected' ? '❌ İmtina' : '⏰ Gecikmə'}`,
      show_alert: false,
    };
    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, answer);
  } catch (e) { /* ignore */ }

  res.sendStatus(200);
});

// ── /webhook route ──────────────────────────────────────────────────────────
app.post('/webhook', express.json(), (req, res) => {
  if (SIGNAL_API_KEY) {
    const incomingKey = req.headers['x-api-key'] || '';
    if (incomingKey !== SIGNAL_API_KEY) {
      console.error(`❌ /webhook: səlahiyyətsiz sorğu`);
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }
  const { asset, status, direction, strategy, reason, metrics, timestamp } = req.body;
  if (!asset || !status) return res.status(400).json({ error: 'Tələb olunan sahələr çatışmır' });

  if (status === 'REJECTED') {
    console.log(`[REJECTED][${asset}] gate=${metrics?.gate ?? '—'} | ${reason}`);
    return res.status(200).json({ received: true, status: 'REJECTED', asset });
  }
  if (status === 'SUCCESS') {
    const { entry, tp1, sl1 } = req.body;
    if (entry == null || tp1 == null || sl1 == null) {
      console.error(`[BLOCKED SUCCESS][${asset}] Ticarət dəyərləri çatışmır`);
      return res.status(200).json({ blocked: true, reason: 'Qiymət sahələri çatışmır' });
    }
    console.log(`[SIGNAL][${asset}] ${direction} @ ${entry} | TP1=${tp1} SL1=${sl1} via ${strategy}`);
    return res.status(200).json({ received: true, status: 'SUCCESS', asset });
  }
  res.status(422).json({ error: `Naməlum status: ${status}` });
});

// ═════════════════════════════════════════════════════════════════════════════
// Ortaq CSS
// ═════════════════════════════════════════════════════════════════════════════
const DASHBOARD_CSS = `
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:system-ui, sans-serif; background:#0d1117; color:#c9d1d9; padding:1rem; }
  .top-nav { display:flex; justify-content:flex-end; gap:1rem; margin-bottom:1rem; flex-wrap:wrap; }
  .nav-link { color:#58a6ff; text-decoration:none; }
  .nav-link.active { font-weight:bold; border-bottom:2px solid #58a6ff; }
  .logout { color:#f85149; }
  h1 { text-align:center; margin-bottom:1rem; }
  .tab-nav { display:flex; gap:0.5rem; margin-bottom:1rem; flex-wrap:wrap; }
  .tab-btn { padding:8px 16px; background:#0d1117; border:1px solid #30363d; color:#c9d1d9; border-radius:4px; cursor:pointer; }
  .tab-btn.active { background:#238636; border-color:#238636; }
  .stats-row { display:flex; gap:1rem; flex-wrap:wrap; justify-content:center; margin:1rem 0; }
  .stat-card { background:#161b22; padding:0.7rem; border-radius:8px; text-align:center; min-width:90px; flex:1; }
  .stat-card strong { font-size:1.3rem; display:block; margin-top:0.2rem; }
  .stat-card small { color:#8b949e; }
  .filter-bar { display:flex; gap:0.5rem; flex-wrap:wrap; margin-bottom:1rem; align-items:center; }
  .filter-bar input, .filter-bar select { padding:8px; background:#0d1117; border:1px solid #30363d; color:#c9d1d9; border-radius:4px; flex:1; min-width:120px; }
  .filter-bar label { color:#c9d1d9; margin-right:-0.3rem; }
  .filter-bar button { margin-left:0.5rem; }
  .table-container { overflow-x:auto; max-height:70vh; overflow-y:auto; }
  table { width:100%; border-collapse:collapse; font-size:0.9rem; }
  th, td { border-bottom:1px solid #30363d; padding:8px; text-align:left; white-space:nowrap; }
  th { background:#161b22; position:sticky; top:0; z-index:1; }
  tr:hover { background:#1c2128; }
  tbody tr:nth-child(even) { background: #161b2250; }
  .detail-btn { background:#238636; border:none; color:white; padding:4px 8px; border-radius:4px; cursor:pointer; }
  .detail-btn:hover { background:#2ea043; }
  .delete-btn { background:#da3633; border:none; color:white; padding:4px 8px; border-radius:4px; cursor:pointer; }
  .delete-btn:hover { background:#f85149; }
  .modal { display:none; position:fixed; left:0; top:0; width:100%; height:100%; background:rgba(0,0,0,0.7); z-index:1000; }
  .modal-content { background:#161b22; margin:10% auto; padding:20px; width:90%; max-width:600px; border-radius:8px; max-height:70vh; overflow-y:auto; }
  .close { color:#aaa; float:right; font-size:28px; font-weight:bold; cursor:pointer; }
  .profit-input { width:80px; background:#0d1117; color:#c9d1d9; border:1px solid #30363d; padding:2px 4px; border-radius:4px; }
  .chart-container { background:#161b22; border-radius:8px; padding:1rem; margin-bottom:1.5rem; }
  .refresh-btn { background:#6e40c9; border:none; color:white; padding:6px 12px; border-radius:4px; cursor:pointer; }
  .badge { display:inline-block; padding:2px 6px; border-radius:3px; font-size:0.8em; }
  .badge-success { background:#238636; color:white; }
  .badge-rejected { background:#607d8b; color:white; }
  .badge-vip { background:#f1c40f; color:#0d1117; }
  .badge-win { background:#00e676; color:#0d1117; }
  .badge-loss { background:#ff5252; color:white; }
  @media (max-width: 768px) {
    .filter-bar { flex-direction: column; align-items: stretch; }
    .filter-bar input, .filter-bar select, .filter-bar button { width:100%; margin:0.2rem 0; }
    th, td { padding:6px; font-size:0.8rem; }
    .stat-card { flex: 100%; }
  }
`;

// ═════════════════════════════════════════════════════════════════════════════
// Ana Dashboard
// ═════════════════════════════════════════════════════════════════════════════
app.get('/', sessionAuth, async (req, res) => {
  const signals = await Signal.find({ status: 'SUCCESS' }).sort({ receivedAt: -1 }).limit(200);
  const signalsData = signals.map(s => ({
    id: s._id.toString(),
    asset: s.asset,
    direction: s.direction,
    strength: s.strength,
    entry: s.entry,
    tp1: s.tp1,
    sl1: s.sl1,
    tp2: s.tp2,
    sl2: s.sl2,
    confidence: s.confidence,
    status: s.status,
    timestamp: s.timestamp,
    reason: s.reason,
    rationale: s.rationale,
    metrics: s.metrics,
    netProfit: s.netProfit,
    outcome: s.outcome,
    exitPrice: s.exitPrice,
  }));

  res.send(`<!DOCTYPE html>
<html lang="az">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>HP Trader Engine v9.1 – Dashboard</title>
  <style>${DASHBOARD_CSS}</style>
</head>
<body>
  <div class="top-nav">
    <a href="/" class="nav-link active">📊 Dashboard</a>
    <a href="/admin" class="nav-link">🔐 Admin Panel</a>
    <a href="/prediction-accuracy" class="nav-link">📈 Proqnoz Dəqiqliyi</a>
    <a href="/model-performance" class="nav-link">🧠 Model Performans</a>
    <a href="/analytics" class="nav-link">📊 Analitika</a>
    <a href="/logout" class="nav-link logout">Çıxış</a>
  </div>
  <h1>📡 HP Trader Engine v9.1 – Son Siqnallar</h1>

  <div class="stats-row" id="statsRow">
    <!-- JS ilə doldurulacaq -->
  </div>

  <div class="filter-bar">
    <input type="text" id="searchAsset" placeholder="Asset adı" oninput="applyFilters()" />
    <select id="filterDir" onchange="applyFilters()">
      <option value="">Bütün istiqamət</option>
      <option value="BUY">BUY</option>
      <option value="SELL">SELL</option>
    </select>
    <select id="filterStrength" onchange="applyFilters()">
      <option value="">Bütün güc</option>
      <option value="STRONG">STRONG</option>
      <option value="NORMAL">NORMAL</option>
    </select>
    <label>Başlanğıc:</label>
    <input type="date" id="startDate" onchange="applyFilters()" />
    <label>Son:</label>
    <input type="date" id="endDate" onchange="applyFilters()" />
    <button onclick="setQuickRange(1)" class="detail-btn">24h</button>
    <button onclick="setQuickRange(7)" class="detail-btn">7d</button>
    <button onclick="setQuickRange(30)" class="detail-btn">30d</button>
    <button onclick="exportCSV()" class="detail-btn" style="background:#6e40c9">📥 CSV</button>
    <button onclick="location.reload()" class="refresh-btn">🔄 Yenilə</button>
  </div>

  <div class="table-container">
    <table id="signalTable">
      <thead>
        <tr><th>Asset</th><th>Vaxt</th><th>İstiqamət</th><th>Güc</th><th>Giriş</th><th>TP1</th><th>TP2</th><th>SL1</th><th>SL2</th><th>İnam</th><th>Nəticə</th><th>Net P/L</th><th>Detal</th></tr>
      </thead>
      <tbody></tbody>
    </table>
  </div>

  <div id="modal" class="modal">
    <div class="modal-content">
      <span class="close" onclick="closeModal()">&times;</span>
      <div id="modal-body"></div>
    </div>
  </div>

  <script>
    const signals = ${JSON.stringify(signalsData)};
    const tableBody = document.querySelector('#signalTable tbody');

    function renderTable(filtered) {
      tableBody.innerHTML = '';
      filtered.forEach(s => {
        const dirColor = s.direction === 'BUY' ? '#00e676' : '#ff5252';
        const strengthIcon = s.strength === 'STRONG' ? '⚡' : '';
        let profitColor = '#c9d1d9';
        if (s.netProfit != null) {
          profitColor = s.netProfit >= 0 ? '#00e676' : '#ff5252';
        }
        let outcomeBadge = '';
        if (s.outcome === 'WIN') outcomeBadge = '<span class="badge badge-win">QƏLƏBƏ</span>';
        else if (s.outcome === 'LOSS') outcomeBadge = '<span class="badge badge-loss">ZƏRƏR</span>';
        else if (s.outcome === 'TIME_STOP') outcomeBadge = '<span class="badge badge-rejected">⏰ VAXT</span>';
        else outcomeBadge = '—';
        
        const row = document.createElement('tr');
        row.innerHTML = \`
          <td>\${escapeHtml(s.asset)}</td>
          <td>\${new Date(s.timestamp).toLocaleString('az-AZ')}</td>
          <td style="color:\${dirColor}; font-weight:\${s.strength === 'STRONG' ? 'bold' : ''}">\${strengthIcon}\${escapeHtml(s.direction)}</td>
          <td>\${s.strength || 'NORMAL'}</td>
          <td>\${s.entry ? s.entry.toFixed(5) : '—'}</td>
          <td>\${s.tp1 ? s.tp1.toFixed(5) : '—'}</td>
          <td>\${s.tp2 ? s.tp2.toFixed(5) : '—'}</td>
          <td>\${s.sl1 ? s.sl1.toFixed(5) : '—'}</td>
          <td>\${s.sl2 ? s.sl2.toFixed(5) : '—'}</td>
          <td>\${s.confidence != null ? s.confidence + '%' : '—'}</td>
          <td>\${outcomeBadge}</td>
          <td style="color:\${profitColor}">\${s.netProfit != null ? s.netProfit.toFixed(2) : '—'}</td>
          <td><button class="detail-btn" onclick="showDetail('\${s.id}')">🔍</button></td>
        \`;
        tableBody.appendChild(row);
      });
    }

    function updateStats(filtered) {
      const total = filtered.length;
      const buy = filtered.filter(s => s.direction === 'BUY').length;
      const sell = total - buy;
      const strong = filtered.filter(s => s.strength === 'STRONG').length;
      let totalProfit = 0;
      const withProfit = filtered.filter(s => s.netProfit != null);
      withProfit.forEach(s => { totalProfit += s.netProfit; });
      const wins = withProfit.filter(s => s.netProfit >= 0).length;
      const winRate = withProfit.length > 0 ? ((wins / withProfit.length) * 100).toFixed(0) + '%' : '—';
      const profitColor = totalProfit >= 0 ? '#00e676' : '#ff5252';

      document.getElementById('statsRow').innerHTML = \`
        <div class="stat-card"><small>💰 Toplam</small><strong>\${total}</strong></div>
        <div class="stat-card"><small>🟢 BUY</small><strong>\${buy}</strong></div>
        <div class="stat-card"><small>🔴 SELL</small><strong>\${sell}</strong></div>
        <div class="stat-card"><small>⚡ STRONG</small><strong>\${strong}</strong></div>
        <div class="stat-card"><small>💵 Net P/L</small><strong style="color:\${profitColor}">\${totalProfit.toFixed(2)}</strong></div>
        <div class="stat-card"><small>🏆 Qələbə %</small><strong>\${winRate}</strong></div>
      \`;
    }

    function applyFilters() {
      const assetFilter = document.getElementById('searchAsset').value.toLowerCase();
      const dirFilter = document.getElementById('filterDir').value;
      const strengthFilter = document.getElementById('filterStrength').value;
      const startDate = document.getElementById('startDate').value;
      const endDate = document.getElementById('endDate').value;
      const filtered = signals.filter(s => {
        if (assetFilter && !s.asset.toLowerCase().includes(assetFilter)) return false;
        if (dirFilter && s.direction !== dirFilter) return false;
        if (strengthFilter && s.strength !== strengthFilter) return false;
        if (startDate || endDate) {
          const d = new Date(s.timestamp).toISOString().slice(0,10);
          if (startDate && d < startDate) return false;
          if (endDate && d > endDate) return false;
        }
        return true;
      });
      renderTable(filtered);
      updateStats(filtered);
    }

    function showDetail(id) {
      const s = signals.find(s => s.id === id);
      if (!s) return;
      const m = s.metrics || {};
      const al = m.audit_log || {};
      let html = '<h3>' + escapeHtml(s.asset) + ' – ' + escapeHtml(s.direction) + '</h3>';
      html += '<p><b>Giriş:</b> ' + escapeHtml(s.entry) + '</p>';
      if (s.tp1) html += '<p><b>TP1:</b> ' + escapeHtml(s.tp1) + '</p>';
      if (s.tp2) html += '<p><b>TP2:</b> ' + escapeHtml(s.tp2) + '</p>';
      if (s.sl1) html += '<p><b>SL1:</b> ' + escapeHtml(s.sl1) + '</p>';
      if (s.sl2) html += '<p><b>SL2:</b> ' + escapeHtml(s.sl2) + '</p>';
      html += '<p><b>İnam:</b> ' + (s.confidence != null ? s.confidence + '%' : '—') + '</p>';
      html += '<p><b>Səbəb:</b> ' + escapeHtml(s.rationale || s.reason) + '</p>';
      if (m.price) html += '<p><b>Qiymət:</b> ' + escapeHtml(m.price) + '</p>';
      if (m.regime) html += '<p><b>Rejim:</b> ' + escapeHtml(m.regime) + '</p>';
      if (m.risk_score != null) html += '<p><b>Risk Skoru:</b> ' + m.risk_score + '/100</p>';
      if (m.prob_tp1 != null) html += '<p><b>TP1 Ehtimalı:</b> ~' + m.prob_tp1 + '%</p>';
      if (m.prob_tp2 != null) html += '<p><b>TP2 Ehtimalı:</b> ~' + m.prob_tp2 + '%</p>';
      html += '<hr/><h4>Audit Log</h4>';
      const sectionOrder = ['CONFIDENCE', 'RSI', 'REGIME', 'CONFLUENCE', 'META', 'RISK', 'DEDUP', 'MTF', 'SESSION'];
      for (const sec of sectionOrder) {
        const entries = al[sec];
        if (entries && entries.length) {
          html += '<h5>' + escapeHtml(sec) + '</h5>';
          entries.forEach(e => {
            html += (e.pass ? '✅' : '❌') + ' ' + escapeHtml(e.label) +
                    ': <code>' + escapeHtml(String(e.current)) + '</code> / ' + escapeHtml(String(e.threshold)) + '<br/>';
          });
        }
      }
      document.getElementById('modal-body').innerHTML = html;
      document.getElementById('modal').style.display = 'block';
    }

    function closeModal() { document.getElementById('modal').style.display = 'none'; }
    function escapeHtml(text) {
      const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
      return String(text).replace(/[&<>"']/g, m => map[m]);
    }
    function setQuickRange(days) {
      const end = new Date();
      const start = new Date(end - days * 86400000);
      document.getElementById('startDate').value = start.toISOString().slice(0,10);
      document.getElementById('endDate').value   = end.toISOString().slice(0,10);
      applyFilters();
    }
    function exportCSV() {
      const filtered = signals;
      const cols = ['asset','direction','strength','status','entry','tp1','sl1','tp2','sl2','confidence','strategy','netProfit','outcome','timestamp'];
      const header = cols.join(',');
      const rows = filtered.map(s => cols.map(c => {
        const val = s[c];
        if (val === null || val === undefined) return '';
        return '"' + String(val).replace(/"/g, '""') + '"';
      }).join(','));
      const csvContent = header + '\\n' + rows.join('\\n');
      const blob = new Blob([csvContent], {type:'text/csv;charset=utf-8;'});
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = \`signals_\${new Date().toISOString().slice(0,10)}.csv\`;
      a.click();
    }
    window.onclick = function(event) { if (event.target == document.getElementById('modal')) closeModal(); };
    applyFilters();
    setInterval(() => location.reload(), 60000); // Hər dəqiqə avtomatik yenilə
  </script>
</body>
</html>`);
});

// ── /admin – BÜTÜN siqnallar ──────────────────────────────────────────────
app.get('/admin', sessionAuth, async (req, res) => {
  const signals = await Signal.find({}).sort({ receivedAt: -1 }).limit(500);
  const signalsData = signals.map(s => ({
    id: s._id.toString(),
    asset: s.asset,
    direction: s.direction,
    strength: s.strength,
    entry: s.entry,
    tp1: s.tp1,
    sl1: s.sl1,
    tp2: s.tp2,
    sl2: s.sl2,
    confidence: s.confidence,
    status: s.status,
    timestamp: s.timestamp,
    reason: s.reason,
    rationale: s.rationale,
    strategy: s.strategy,
    metrics: s.metrics,
    netProfit: s.netProfit,
    outcome: s.outcome,
    exitPrice: s.exitPrice,
    trailing: s.trailing,
    regime: s.regime,
  }));

  res.send(`<!DOCTYPE html>
<html lang="az">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin Panel – HP Trader Engine v9.1</title>
  <style>${DASHBOARD_CSS}</style>
</head>
<body>
  <div class="top-nav">
    <a href="/" class="nav-link">📊 Dashboard</a>
    <a href="/admin" class="nav-link active">🔐 Admin Panel</a>
    <a href="/prediction-accuracy" class="nav-link">📈 Proqnoz Dəqiqliyi</a>
    <a href="/model-performance" class="nav-link">🧠 Model Performans</a>
    <a href="/analytics" class="nav-link">📊 Analitika</a>
    <a href="/logout" class="nav-link logout">Çıxış</a>
  </div>
  <h1>🔐 Admin Panel – Bütün Siqnallar</h1>

  <div class="stats-row" id="statsRow"></div>

  <div id="gateChart" style="margin:1rem 0; background:#161b22; border-radius:8px; padding:0.7rem;"></div>

  <div class="filter-bar">
    <input type="text" id="searchAsset" placeholder="Asset adı" oninput="applyFilters()" />
    <select id="filterDir" onchange="applyFilters()">
      <option value="">Bütün istiqamət</option>
      <option value="BUY">BUY</option>
      <option value="SELL">SELL</option>
    </select>
    <select id="filterStrength" onchange="applyFilters()">
      <option value="">Bütün güc</option>
      <option value="STRONG">STRONG</option>
      <option value="NORMAL">NORMAL</option>
    </select>
    <select id="filterStatus" onchange="applyFilters()">
      <option value="">Bütün status</option>
      <option value="SUCCESS">SUCCESS</option>
      <option value="REJECTED">REJECTED</option>
      <option value="VIP_SIGNAL">VIP_SIGNAL</option>
      <option value="TEST">TEST</option>
    </select>
    <label>Başlanğıc:</label>
    <input type="date" id="startDate" onchange="applyFilters()" />
    <label>Son:</label>
    <input type="date" id="endDate" onchange="applyFilters()" />
    <button onclick="setQuickRange(1)" class="detail-btn">24h</button>
    <button onclick="setQuickRange(7)" class="detail-btn">7d</button>
    <button onclick="setQuickRange(30)" class="detail-btn">30d</button>
    <button onclick="exportCSV()" class="detail-btn" style="background:#6e40c9">📥 CSV</button>
    <button id="deleteSelectedBtn" onclick="deleteSelected()" class="delete-btn">
      🗑️ Seçilənləri Sil
    </button>
    <button onclick="location.reload()" class="refresh-btn">🔄 Yenilə</button>
  </div>

  <div class="table-container">
    <table id="signalTable">
      <thead>
        <tr>
          <th><input type="checkbox" id="selectAll" onclick="toggleSelectAll(this)" /></th>
          <th>Asset</th><th>Vaxt</th><th>İstiqamət</th><th>Güc</th><th>Status</th><th>Giriş</th><th>TP1</th><th>TP2</th><th>SL1</th><th>SL2</th><th>İnam</th><th>Səbəb</th><th>Nəticə</th><th>Net P/L</th><th>Detal</th>
        </tr>
      </thead>
      <tbody></tbody>
    </table>
  </div>

  <div id="modal" class="modal">
    <div class="modal-content">
      <span class="close" onclick="closeModal()">&times;</span>
      <div id="modal-body"></div>
    </div>
  </div>

  <script>
    const signals = ${JSON.stringify(signalsData)};
    const tableBody = document.querySelector('#signalTable tbody');
    let selectedIds = new Set();

    function renderTable(filtered) {
      tableBody.innerHTML = '';
      filtered.forEach(s => {
        const dirColor = s.direction === 'BUY' ? '#00e676' : '#ff5252';
        const strengthIcon = s.strength === 'STRONG' ? '⚡' : '';
        let statusBadge;
        if (s.status === 'REJECTED') statusBadge = '<span class="badge badge-rejected">🚫 REJECTED</span>';
        else if (s.status === 'VIP_SIGNAL') statusBadge = '<span class="badge badge-vip">👑 VIP</span>';
        else if (s.status === 'TEST') statusBadge = '<span class="badge badge-rejected">🧪 TEST</span>';
        else statusBadge = '<span class="badge badge-success">✅ SUCCESS</span>';
        const netProfitVal = (s.netProfit != null) ? s.netProfit : '';
        let profitColor = '#c9d1d9';
        if (s.netProfit != null) profitColor = s.netProfit >= 0 ? '#00e676' : '#ff5252';
        let outcomeBadge = '';
        if (s.outcome === 'WIN') outcomeBadge = '<span class="badge badge-win">QƏLƏBƏ</span>';
        else if (s.outcome === 'LOSS') outcomeBadge = '<span class="badge badge-loss">ZƏRƏR</span>';
        else if (s.outcome === 'TIME_STOP') outcomeBadge = '<span class="badge badge-rejected">⏰ VAXT</span>';
        else outcomeBadge = '—';
        const checked = selectedIds.has(s.id) ? 'checked' : '';
        const row = document.createElement('tr');
        row.innerHTML = \`
          <td><input type="checkbox" class="signal-checkbox" data-id="\${s.id}" \${checked} onchange="toggleSignal('\${s.id}', this)" /></td>
          <td>\${escapeHtml(s.asset)}</td>
          <td>\${new Date(s.timestamp).toLocaleString('az-AZ')}</td>
          <td style="color:\${dirColor}; font-weight:\${s.strength === 'STRONG' ? 'bold' : ''}">\${strengthIcon}\${escapeHtml(s.direction)}</td>
          <td>\${s.strength || 'NORMAL'}</td>
          <td>\${statusBadge}</td>
          <td>\${s.entry ? s.entry.toFixed(5) : '—'}</td>
          <td>\${s.tp1 ? s.tp1.toFixed(5) : '—'}</td>
          <td>\${s.tp2 ? s.tp2.toFixed(5) : '—'}</td>
          <td>\${s.sl1 ? s.sl1.toFixed(5) : '—'}</td>
          <td>\${s.sl2 ? s.sl2.toFixed(5) : '—'}</td>
          <td>\${s.confidence != null ? s.confidence + '%' : '—'}</td>
          <td>\${escapeHtml(s.rationale || s.reason || '—')}</td>
          <td>\${outcomeBadge}</td>
          <td><input type="number" step="any" value="\${netProfitVal}" 
                 onblur="saveNetProfit('\${s.id}', this)" 
                 class="profit-input" placeholder="0.00"
                 style="color:\${profitColor}" /></td>
          <td><button class="detail-btn" onclick="showDetail('\${s.id}')">🔍</button></td>
        \`;
        tableBody.appendChild(row);
      });
    }

    function updateStats(filtered) {
      const total = filtered.length;
      const success = filtered.filter(s => s.status === 'SUCCESS').length;
      const rejected = filtered.filter(s => s.status === 'REJECTED').length;
      const vip = filtered.filter(s => s.status === 'VIP_SIGNAL').length;
      const strong = filtered.filter(s => s.strength === 'STRONG').length;
      let totalProfit = 0;
      filtered.forEach(s => { if (s.netProfit != null) totalProfit += s.netProfit; });
      const profitColor = totalProfit >= 0 ? '#00e676' : '#ff5252';
      const totalSignals = filtered.filter(s => s.status !== 'REJECTED').length;
      const passRate = totalSignals > 0 ? ((success / totalSignals * 100).toFixed(1)) : '—';
      const withProfit = filtered.filter(s => s.netProfit != null);
      const wins = withProfit.filter(s => s.netProfit >= 0).length;
      const winRate = withProfit.length > 0 ? ((wins / withProfit.length) * 100).toFixed(0) + '%' : '—';

      document.getElementById('statsRow').innerHTML = \`
        <div class="stat-card"><small>📨 Toplam</small><strong>\${total}</strong></div>
        <div class="stat-card"><small>✅ SUCCESS</small><strong>\${success}</strong></div>
        <div class="stat-card"><small>🚫 REJECTED</small><strong>\${rejected}</strong></div>
        <div class="stat-card"><small>👑 VIP</small><strong>\${vip}</strong></div>
        <div class="stat-card"><small>⚡ STRONG</small><strong>\${strong}</strong></div>
        <div class="stat-card"><small>💵 Net P/L</small><strong style="color:\${profitColor}">\${totalProfit.toFixed(2)}</strong></div>
        <div class="stat-card"><small>🎯 Keçid %</small><strong>\${passRate}%</strong></div>
        <div class="stat-card"><small>🏆 Qələbə %</small><strong>\${winRate}</strong></div>
      \`;
    }

    function applyFilters() {
      const assetFilter = document.getElementById('searchAsset').value.toLowerCase();
      const dirFilter = document.getElementById('filterDir').value;
      const strengthFilter = document.getElementById('filterStrength').value;
      const statusFilter = document.getElementById('filterStatus').value;
      const startDate = document.getElementById('startDate').value;
      const endDate = document.getElementById('endDate').value;
      const filtered = signals.filter(s => {
        if (assetFilter && !s.asset.toLowerCase().includes(assetFilter)) return false;
        if (dirFilter && s.direction !== dirFilter) return false;
        if (strengthFilter && s.strength !== strengthFilter) return false;
        if (statusFilter && s.status !== statusFilter) return false;
        if (startDate || endDate) {
          const d = new Date(s.timestamp).toISOString().slice(0,10);
          if (startDate && d < startDate) return false;
          if (endDate && d > endDate) return false;
        }
        return true;
      });
      renderTable(filtered);
      updateStats(filtered);
    }

    function showDetail(id) {
      const s = signals.find(s => s.id === id);
      if (!s) return;
      const m = s.metrics || {};
      const al = m.audit_log || {};
      let html = '<h3>' + escapeHtml(s.asset) + ' – ' + escapeHtml(s.direction) + '</h3>';
      html += '<p><b>Giriş:</b> ' + escapeHtml(s.entry) + '</p>';
      if (s.tp1) html += '<p><b>TP1:</b> ' + escapeHtml(s.tp1) + '</p>';
      if (s.tp2) html += '<p><b>TP2:</b> ' + escapeHtml(s.tp2) + '</p>';
      if (s.sl1) html += '<p><b>SL1:</b> ' + escapeHtml(s.sl1) + '</p>';
      if (s.sl2) html += '<p><b>SL2:</b> ' + escapeHtml(s.sl2) + '</p>';
      html += '<p><b>İnam:</b> ' + (s.confidence != null ? s.confidence + '%' : '—') + '</p>';
      html += '<p><b>Səbəb:</b> ' + escapeHtml(s.rationale || s.reason) + '</p>';
      if (m.price) html += '<p><b>Qiymət:</b> ' + escapeHtml(m.price) + '</p>';
      if (m.regime) html += '<p><b>Rejim:</b> ' + escapeHtml(m.regime) + '</p>';
      if (m.risk_score != null) html += '<p><b>Risk Skoru:</b> ' + m.risk_score + '/100</p>';
      if (s.trailing) html += '<p><b>Trailing Stop:</b> Aktivləşmə @' + s.trailing.activate_at + ', Məsafə=' + s.trailing.distance + '</p>';
      html += '<hr/><h4>Audit Log</h4>';
      const sectionOrder = ['CONFIDENCE', 'RSI', 'REGIME', 'CONFLUENCE', 'META', 'RISK', 'DEDUP', 'MTF', 'SESSION'];
      for (const sec of sectionOrder) {
        const entries = al[sec];
        if (entries && entries.length) {
          html += '<h5>' + escapeHtml(sec) + '</h5>';
          entries.forEach(e => {
            html += (e.pass ? '✅' : '❌') + ' ' + escapeHtml(e.label) +
                    ': <code>' + escapeHtml(String(e.current)) + '</code> / ' + escapeHtml(String(e.threshold)) + '<br/>';
          });
        }
      }
      document.getElementById('modal-body').innerHTML = html;
      document.getElementById('modal').style.display = 'block';
    }

    function closeModal() { document.getElementById('modal').style.display = 'none'; }
    function escapeHtml(text) {
      const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
      return String(text).replace(/[&<>"']/g, m => map[m]);
    }

    async function saveNetProfit(id, input) {
      const value = parseFloat(input.value);
      if (isNaN(value)) return;
      try {
        const resp = await fetch('/signal/' + id + '/netProfit', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ netProfit: value })
        });
        if (resp.ok) {
          const signal = signals.find(s => s.id === id);
          if (signal) signal.netProfit = value;
          input.style.color = value >= 0 ? '#00e676' : '#ff5252';
        }
      } catch (err) { console.error(err); }
    }

    function toggleSignal(id, checkbox) {
      if (checkbox.checked) selectedIds.add(id);
      else selectedIds.delete(id);
      document.getElementById('selectAll').checked = (selectedIds.size === signals.length);
    }
    function toggleSelectAll(checkbox) {
      selectedIds.clear();
      if (checkbox.checked) signals.forEach(s => selectedIds.add(s.id));
      applyFilters();
    }

    async function deleteSelected() {
      if (selectedIds.size === 0) return alert('Heç bir siqnal seçilməyib.');
      if (!confirm(selectedIds.size + ' siqnalı silmək istədiyinizə əminsiniz?')) return;
      try {
        const resp = await fetch('/signals', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: Array.from(selectedIds) })
        });
        if (resp.ok) {
          const idsToDelete = new Set(selectedIds);
          const newSignals = signals.filter(s => !idsToDelete.has(s.id));
          signals.length = 0; signals.push(...newSignals);
          selectedIds.clear();
          applyFilters();
        }
      } catch (err) { console.error(err); }
    }

    function setQuickRange(days) {
      const end = new Date();
      const start = new Date(end - days * 86400000);
      document.getElementById('startDate').value = start.toISOString().slice(0,10);
      document.getElementById('endDate').value   = end.toISOString().slice(0,10);
      applyFilters();
    }

    function exportCSV() {
      const filtered = signals;
      const cols = ['asset','direction','strength','status','entry','tp1','sl1','tp2','sl2','confidence','strategy','netProfit','outcome','timestamp'];
      const header = cols.join(',');
      const rows = filtered.map(s => cols.map(c => {
        const val = s[c];
        if (val === null || val === undefined) return '';
        return '"' + String(val).replace(/"/g, '""') + '"';
      }).join(','));
      const csvContent = header + '\\n' + rows.join('\\n');
      const blob = new Blob([csvContent], {type:'text/csv;charset=utf-8;'});
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = \`signals_\${new Date().toISOString().slice(0,10)}.csv\`;
      a.click();
    }

    async function loadGateStats() {
      try {
        const resp = await fetch('/api/stats');
        const data = await resp.json();
        const gates = data.gateFrequency || [];
        if (gates.length) {
          const total = gates.reduce((s,g) => s + g.count, 0);
          document.getElementById('gateChart').innerHTML = '<h4>🚫 Rədd Gate Tezliyi</h4>' +
            gates.map(g => {
              const pct = ((g.count/total)*100).toFixed(1);
              return '<div style="margin:4px 0;"><span style="display:inline-block;width:150px;">' + escapeHtml(g.gate) + '</span>' +
                     '<span style="display:inline-block;background:#238636;height:16px;width:' + pct + '%;min-width:2px;border-radius:3px;"></span> ' + g.count + ' (' + pct + '%)</div>';
            }).join('');
        }
      } catch(e) {}
    }

    window.onclick = function(event) { if (event.target == document.getElementById('modal')) closeModal(); };
    document.addEventListener('DOMContentLoaded', loadGateStats);
    applyFilters();
  </script>
</body>
</html>`);
});

// ── /prediction-accuracy – Proqnoz Dəqiqliyi Paneli ─────────────────
app.get('/prediction-accuracy', sessionAuth, async (req, res) => {
  try {
    const assetList = await PredictionAccuracy.distinct('asset');
    const assets = ['ALL', ...assetList.filter(a => a !== 'ALL').sort()];

    res.send(`<!DOCTYPE html>
<html lang="az">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Proqnoz Dəqiqliyi – HP Trader Engine</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
  <style>${DASHBOARD_CSS}</style>
</head>
<body>
  <div class="top-nav">
    <a href="/" class="nav-link">📊 Dashboard</a>
    <a href="/admin" class="nav-link">🔐 Admin</a>
    <a href="/prediction-accuracy" class="nav-link active">📈 Proqnoz Dəqiqliyi</a>
    <a href="/model-performance" class="nav-link">🧠 Model Performans</a>
    <a href="/analytics" class="nav-link">📊 Analitika</a>
    <a href="/logout" class="nav-link logout">Çıxış</a>
  </div>
  <h1>📈 Meta‑Model Proqnoz Dəqiqliyi</h1>

  <div class="filter-bar">
    <label>Aktiv:</label>
    <select id="assetSelect">
      ${assets.map(a => `<option value="${a}">${a === 'ALL' ? 'Bütün Aktivlər' : a}</option>`).join('')}
    </select>
    <label>Başlanğıc:</label>
    <input type="date" id="startDate" value="${new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)}"/>
    <label>Son:</label>
    <input type="date" id="endDate" value="${new Date().toISOString().slice(0, 10)}"/>
    <button onclick="loadData()">🔄 Yenilə</button>
  </div>

  <div class="stats-grid" id="statsContainer" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:1rem;margin-bottom:1.5rem;"></div>

  <div class="chart-container">
    <div class="chart-tabs" id="chartTabs" style="display:flex;gap:0.5rem;margin-bottom:1rem;">
      <span class="chart-tab active" data-metric="pearson_r" style="padding:6px 14px;background:#238636;border-radius:4px;cursor:pointer;">Pearson r</span>
      <span class="chart-tab" data-metric="r_squared" style="padding:6px 14px;background:#0d1117;border:1px solid #30363d;border-radius:4px;cursor:pointer;">R²</span>
      <span class="chart-tab" data-metric="slope" style="padding:6px 14px;background:#0d1117;border:1px solid #30363d;border-radius:4px;cursor:pointer;">Slope</span>
      <span class="chart-tab" data-metric="spearman_r" style="padding:6px 14px;background:#0d1117;border:1px solid #30363d;border-radius:4px;cursor:pointer;">Spearman ρ</span>
    </div>
    <canvas id="accuracyChart" height="300"></canvas>
  </div>

  <h3>📋 Son Qeydlər</h3>
  <div class="table-container">
    <table id="recordsTable">
      <thead><tr><th>Tarix</th><th>n</th><th>Pearson r</th><th>Spearman ρ</th><th>R²</th><th>Slope</th><th>Ort. Proqnoz</th><th>Ort. Faktiki</th></tr></thead>
      <tbody></tbody>
    </table>
  </div>

  <script>
    let chartInstance = null;
    let currentMetric = 'pearson_r';

    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get('asset')) document.getElementById('assetSelect').value = urlParams.get('asset');

    function renderChart(labels, data) {
      const ctx = document.getElementById('accuracyChart').getContext('2d');
      const metric = currentMetric;
      const values = data[metric] || [];
      const colors = { pearson_r: '#00e676', spearman_r: '#f1c40f', r_squared: '#58a6ff', slope: '#e040fb' };
      if (chartInstance) chartInstance.destroy();
      chartInstance = new Chart(ctx, {
        type: 'line',
        data: {
          labels: labels,
          datasets: [{
            label: {pearson_r:'Pearson r',spearman_r:'Spearman ρ',r_squared:'R²',slope:'Slope'}[metric] || metric,
            data: values,
            borderColor: colors[metric] || '#c9d1d9',
            backgroundColor: 'transparent',
            pointRadius: 3,
            tension: 0.2
          }]
        },
        options: {
          responsive: true,
          plugins: { legend: { display: false } },
          scales: {
            x: { ticks: { color: '#8b949e' }, grid: { color: '#21262d' } },
            y: { ticks: { color: '#8b949e' }, grid: { color: '#21262d' } }
          }
        }
      });
    }

    document.getElementById('chartTabs').addEventListener('click', (e) => {
      if (e.target.classList.contains('chart-tab')) {
        document.querySelectorAll('.chart-tab').forEach(t => {
          t.style.background = '#0d1117';
          t.style.border = '1px solid #30363d';
        });
        e.target.style.background = '#238636';
        e.target.style.borderColor = '#238636';
        currentMetric = e.target.dataset.metric;
        loadData();
      }
    });

    async function loadData() {
      const asset = document.getElementById('assetSelect').value;
      const from = document.getElementById('startDate').value + 'T00:00:00Z';
      const to   = document.getElementById('endDate').value   + 'T23:59:59Z';

      const chartUrl = \`/api/prediction-accuracy/chart?asset=\${asset}&from=\${from}&to=\${to}\`;
      try {
        const resp = await fetch(chartUrl, { credentials: 'same-origin' });
        const chartJson = await resp.json();
        if (chartJson.chartData) renderChart(chartJson.chartData.labels, chartJson.chartData);
      } catch(e) { console.error('Chart data error:', e); }

      const listUrl = \`/api/prediction-accuracy?asset=\${asset}&from=\${from}&to=\${to}&limit=100\`;
      try {
        const resp = await fetch(listUrl, { credentials: 'same-origin' });
        const data = await resp.json();
        const records = data.records || [];
        const tbody = document.querySelector('#recordsTable tbody');
        tbody.innerHTML = records.map(r => {
          const pr = r.pearson_r != null ? r.pearson_r.toFixed(3) : '—';
          const sr = r.spearman_r != null ? r.spearman_r.toFixed(3) : '—';
          const r2 = r.r_squared != null ? r.r_squared.toFixed(3) : '—';
          const sl = r.slope != null ? r.slope.toFixed(3) : '—';
          const mp = r.mean_predicted != null ? (r.mean_predicted*100).toFixed(2)+'%' : '—';
          const ma = r.mean_actual != null ? (r.mean_actual*100).toFixed(2)+'%' : '—';
          const pColor = r.pearson_r >= 0.4 ? '#00e676' : r.pearson_r >= 0.2 ? '#f1c40f' : '#ff5252';
          return \`<tr>
            <td>\${new Date(r.timestamp).toLocaleString('az-AZ')}</td>
            <td><strong>\${r.n_pairs}</strong></td>
            <td style="color:\${pColor}">\${pr}</td>
            <td style="color:#f1c40f">\${sr}</td>
            <td style="color:\${r.r_squared>=0.15?'#00e676':'#f1c40f'}">\${r2}</td>
            <td style="color:\${r.slope>=0.7 && r.slope<=1.3?'#00e676':'#f1c40f'}">\${sl}</td>
            <td>\${mp}</td>
            <td>\${ma}</td>
          </tr>\`;
        }).join('');

        const latest = records[records.length-1];
        const avg = (arr, field) => arr.length ? (arr.reduce((s,r)=>s+(r[field]||0),0)/arr.length).toFixed(3) : '—';
        const statsHtml = latest ? \`
          <div class="stat-card"><small>📊 Son n</small><div class="value" style="font-size:1.8rem;font-weight:bold;">\${latest.n_pairs}</div></div>
          <div class="stat-card"><small>🔗 Pearson r</small><div class="value" style="font-size:1.8rem;font-weight:bold;color:\${latest.pearson_r>=0.4?'#00e676':'#f1c40f'}">\${latest.pearson_r?.toFixed(3)??'—'}</div></div>
          <div class="stat-card"><small>📐 R²</small><div class="value" style="font-size:1.8rem;font-weight:bold;color:\${latest.r_squared>=0.15?'#00e676':'#f1c40f'}">\${latest.r_squared?.toFixed(3)??'—'}</div></div>
          <div class="stat-card"><small>📏 Slope</small><div class="value" style="font-size:1.8rem;font-weight:bold;">\${latest.slope?.toFixed(3)??'—'}</div></div>
          <div class="stat-card"><small>📈 Ort. Pearson</small><div class="value" style="font-size:1.8rem;font-weight:bold;">\${avg(records,'pearson_r')}</div></div>
          <div class="stat-card"><small>📉 Ort. R²</small><div class="value" style="font-size:1.8rem;font-weight:bold;">\${avg(records,'r_squared')}</div></div>
        \` : '<div class="stat-card">Məlumat yoxdur</div>';
        document.getElementById('statsContainer').innerHTML = statsHtml;
      } catch(e) { console.error('Records error:', e); }
    }

    loadData();
  </script>
</body>
</html>`);
  } catch (err) {
    res.status(500).send('Server xətası');
  }
});

// ── /model-performance – Model Performans Dashboard-ı ──────────────────
app.get('/model-performance', sessionAuth, async (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="az">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Model Performans – HP Trader Engine</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
  <style>${DASHBOARD_CSS}</style>
</head>
<body>
  <div class="top-nav">
    <a href="/" class="nav-link">📊 Dashboard</a>
    <a href="/admin" class="nav-link">🔐 Admin</a>
    <a href="/prediction-accuracy" class="nav-link">📈 Proqnoz Dəqiqliyi</a>
    <a href="/model-performance" class="nav-link active">🧠 Model Performans</a>
    <a href="/analytics" class="nav-link">📊 Analitika</a>
    <a href="/logout" class="nav-link logout">Çıxış</a>
  </div>
  <h1>🧠 Model Performans İzləməsi</h1>

  <div class="filter-bar">
    <label>Aktiv:</label>
    <input type="text" id="assetInput" placeholder="Məs: EURUSD" value="EURUSD" style="flex:1"/>
    <button onclick="loadData()">🔄 Yenilə</button>
  </div>

  <div class="stats-grid" id="statsContainer" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:1rem;margin-bottom:1.5rem;"></div>

  <div class="chart-container">
    <div class="chart-tabs" id="chartTabs" style="display:flex;gap:0.5rem;margin-bottom:1rem;">
      <span class="chart-tab active" data-metric="sharpe" style="padding:6px 14px;background:#238636;border-radius:4px;cursor:pointer;">Sharpe</span>
      <span class="chart-tab" data-metric="rmse" style="padding:6px 14px;background:#0d1117;border:1px solid #30363d;border-radius:4px;cursor:pointer;">RMSE</span>
      <span class="chart-tab" data-metric="mae" style="padding:6px 14px;background:#0d1117;border:1px solid #30363d;border-radius:4px;cursor:pointer;">MAE</span>
      <span class="chart-tab" data-metric="direction_accuracy" style="padding:6px 14px;background:#0d1117;border:1px solid #30363d;border-radius:4px;cursor:pointer;">İstiqamət Dəqiqliyi</span>
    </div>
    <canvas id="perfChart" height="300"></canvas>
  </div>

  <h3>📋 Son Qeydlər</h3>
  <div class="table-container">
    <table id="recordsTable">
      <thead><tr><th>Tarix</th><th>Model</th><th>Sharpe</th><th>RMSE</th><th>MAE</th><th>İstiq. Dəq.</th></tr></thead>
      <tbody></tbody>
    </table>
  </div>

  <script>
    let chartInstance = null;
    let currentMetric = 'sharpe';

    function renderChart(labels, datasets) {
      const ctx = document.getElementById('perfChart').getContext('2d');
      const colors = ['#00e676','#f1c40f','#e040fb','#58a6ff'];
      if (chartInstance) chartInstance.destroy();
      chartInstance = new Chart(ctx, {
        type: 'line',
        data: {
          labels: labels,
          datasets: datasets.map((ds, i) => ({
            label: ds.model,
            data: ds.values,
            borderColor: colors[i % colors.length],
            backgroundColor: 'transparent',
            pointRadius: 2,
            tension: 0.1
          }))
        },
        options: {
          responsive: true,
          plugins: { legend: { display: true } },
          scales: {
            x: { ticks: { color: '#8b949e' }, grid: { color: '#21262d' } },
            y: { ticks: { color: '#8b949e' }, grid: { color: '#21262d' } }
          }
        }
      });
    }

    function setActiveTab(tab) {
      document.querySelectorAll('.chart-tab').forEach(t => {
        t.style.background = '#0d1117';
        t.style.border = '1px solid #30363d';
      });
      tab.style.background = '#238636';
      tab.style.borderColor = '#238636';
      currentMetric = tab.dataset.metric;
      loadData();
    }
    document.getElementById('chartTabs').addEventListener('click', (e) => {
      if (e.target.classList.contains('chart-tab')) setActiveTab(e.target);
    });

    async function loadData() {
      const asset = document.getElementById('assetInput').value.trim().toUpperCase();
      if (!asset) return;
      try {
        const resp = await fetch(\`/api/proxy/model-performance?asset=\${encodeURIComponent(asset)}\`);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const data = await resp.json();
        const records = data.records || [];
        if (!records.length) {
          document.getElementById('statsContainer').innerHTML = '<div class="stat-card">Məlumat yoxdur</div>';
          document.querySelector('#recordsTable tbody').innerHTML = '';
          return;
        }
        const models = {};
        records.forEach(r => {
          if (!models[r.model_name]) models[r.model_name] = [];
          models[r.model_name].push({
            timestamp: r.timestamp,
            sharpe: r.sharpe,
            rmse: r.rmse,
            mae: r.mae,
            direction_accuracy: r.direction_accuracy
          });
        });

        const timestamps = [...new Set(records.map(r => r.timestamp))].sort();
        const datasets = Object.entries(models).map(([model, points]) => {
          const map = new Map(points.map(p => [p.timestamp, p[currentMetric] ?? null]));
          return {
            model,
            values: timestamps.map(ts => map.get(ts))
          };
        });
        renderChart(timestamps.map(ts => new Date(ts).toLocaleString('az-AZ')), datasets);

        const tbody = document.querySelector('#recordsTable tbody');
        tbody.innerHTML = records.map(r => {
          const sh = r.sharpe != null ? r.sharpe.toFixed(3) : '—';
          const rm = r.rmse != null ? r.rmse.toFixed(6) : '—';
          const ma = r.mae != null ? r.mae.toFixed(6) : '—';
          const da = r.direction_accuracy != null ? (r.direction_accuracy*100).toFixed(0)+'%' : '—';
          return \`<tr>
            <td>\${new Date(r.timestamp).toLocaleString('az-AZ')}</td>
            <td><strong>\${r.model_name}</strong></td>
            <td>\${sh}</td>
            <td>\${rm}</td>
            <td>\${ma}</td>
            <td>\${da}</td>
          </tr>\`;
        }).join('');

        const latest = records[records.length-1];
        const bestSharpe = Math.max(...records.filter(r => r.sharpe != null).map(r => r.sharpe));
        const statsHtml = \`
          <div class="stat-card"><small>📊 Son Sharpe</small><div class="value" style="font-size:1.8rem;font-weight:bold;">\${(latest.sharpe ?? 0).toFixed(3)}</div></div>
          <div class="stat-card"><small>🏆 Ən Yaxşı Sharpe</small><div class="value" style="font-size:1.8rem;font-weight:bold;">\${bestSharpe.toFixed(3)}</div></div>
          <div class="stat-card"><small>📉 Son RMSE</small><div class="value" style="font-size:1.8rem;font-weight:bold;">\${(latest.rmse ?? 0).toFixed(6)}</div></div>
          <div class="stat-card"><small>🎯 Son İstiq. Dəq.</small><div class="value" style="font-size:1.8rem;font-weight:bold;">\${(latest.direction_accuracy ? (latest.direction_accuracy*100).toFixed(0)+'%' : '—')}</div></div>
        \`;
        document.getElementById('statsContainer').innerHTML = statsHtml;
      } catch (err) {
        console.error('Model performans yükləmə xətası:', err);
      }
    }
    loadData();
  </script>
</body>
</html>`);
});

// ── /analytics – Analitika Panel ────────────────────────────────────────
app.get('/analytics', sessionAuth, async (req, res) => {
  try {
    const profitByAsset = await Signal.aggregate([
      { $match: { netProfit: { $ne: null } } },
      { $group: { _id: '$asset', totalProfit: { $sum: '$netProfit' }, count: { $sum: 1 }, wins: { $sum: { $cond: [{ $gte: ['$netProfit', 0] }, 1, 0] } } } },
      { $sort: { totalProfit: -1 } }
    ]);

    const statusCounts = await Signal.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]);

    const dailySignals = await Signal.aggregate([
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$receivedAt' } }, count: { $sum: 1 } } },
      { $sort: { _id: -1 } },
      { $limit: 30 }
    ]);

    const feedbackSummary = await Feedback.aggregate([
      { $group: { _id: '$action', count: { $sum: 1 } } },
    ]);

    res.send(`<!DOCTYPE html>
<html lang="az">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Analitika – HP Trader Engine</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
  <style>${DASHBOARD_CSS}</style>
</head>
<body>
  <div class="top-nav">
    <a href="/" class="nav-link">📊 Dashboard</a>
    <a href="/admin" class="nav-link">🔐 Admin</a>
    <a href="/prediction-accuracy" class="nav-link">📈 Proqnoz Dəqiqliyi</a>
    <a href="/model-performance" class="nav-link">🧠 Model Performans</a>
    <a href="/analytics" class="nav-link active">📊 Analitika</a>
    <a href="/logout" class="nav-link logout">Çıxış</a>
  </div>
  <h1>📊 Analitika Paneli</h1>

  <div class="stats-row">
    <div class="stat-card"><small>💰 Ümumi P/L</small><strong style="color:${profitByAsset.reduce((s,a) => s + a.totalProfit, 0) >= 0 ? '#00e676' : '#ff5252'}">${profitByAsset.reduce((s,a) => s + a.totalProfit, 0).toFixed(2)}</strong></div>
    <div class="stat-card"><small>📊 Aktiv Sayı</small><strong>${profitByAsset.length}</strong></div>
    <div class="stat-card"><small>📝 Rəy Sayı</small><strong>${feedbackSummary.reduce((s,a) => s + a.count, 0)}</strong></div>
  </div>

  <div style="display:grid; grid-template-columns:1fr 1fr; gap:1rem; margin:1rem 0;">
    <div class="chart-container">
      <h3>Asset üzrə P/L</h3>
      <canvas id="profitChart" height="250"></canvas>
    </div>
    <div class="chart-container">
      <h3>Gündəlik Siqnal Sayı</h3>
      <canvas id="dailyChart" height="250"></canvas>
    </div>
  </div>

  <h3>İstifadəçi Rəy Xülasəsi</h3>
  <div class="table-container">
    <table>
      <thead><tr><th>Fəaliyyət</th><th>Say</th></tr></thead>
      <tbody>
        ${feedbackSummary.map(f => `<tr><td>${f._id === 'executed' ? '✅ İcra' : f._id === 'rejected' ? '❌ İmtina' : f._id === 'late' ? '⏰ Gecikmə' : f._id}</td><td>${f.count}</td></tr>`).join('')}
      </tbody>
    </table>
  </div>

  <script>
    // Asset P/L chart
    const profitCtx = document.getElementById('profitChart').getContext('2d');
    new Chart(profitCtx, {
      type: 'bar',
      data: {
        labels: ${JSON.stringify(profitByAsset.map(a => a._id))},
        datasets: [{
          label: 'Net P/L',
          data: ${JSON.stringify(profitByAsset.map(a => a.totalProfit))},
          backgroundColor: ${JSON.stringify(profitByAsset.map(a => a.totalProfit >= 0 ? '#00e676' : '#ff5252'))},
        }]
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: '#8b949e' }, grid: { color: '#21262d' } },
          y: { ticks: { color: '#8b949e' }, grid: { color: '#21262d' } }
        }
      }
    });

    // Daily signals chart
    const dailyCtx = document.getElementById('dailyChart').getContext('2d');
    new Chart(dailyCtx, {
      type: 'bar',
      data: {
        labels: ${JSON.stringify(dailySignals.map(d => d._id).reverse())},
        datasets: [{
          label: 'Siqnal Sayı',
          data: ${JSON.stringify(dailySignals.map(d => d.count).reverse())},
          backgroundColor: '#58a6ff',
        }]
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: '#8b949e' }, grid: { color: '#21262d' } },
          y: { ticks: { color: '#8b949e' }, grid: { color: '#21262d' } }
        }
      }
    });
  </script>
</body>
</html>`);
  } catch (err) {
    res.status(500).send('Analitika yükləmə xətası: ' + err.message);
  }
});

// ─── Server başlatma ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 HP Trader Engine v9.1 – Dispatcher port ${PORT}-də`);
  startupTest();
});
