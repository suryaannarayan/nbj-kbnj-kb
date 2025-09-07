/**
 * Google Apps Script backend for Spreadsheet-based banking demo.
 * Deploy: New project > Services: add Sheets API > Publish > Deploy as Web App
 * Set "Who has access" to Anyone (or Anyone with link). Protect admin endpoints with ADMIN_TOKEN.
 */

const ADMIN_TOKEN = PropertiesService.getScriptProperties().getProperty('ADMIN_TOKEN') || 'change-me';
const SPREADSHEET_ID = '%SPREADSHEET_ID%'; // Fill with your sheet ID
const SHEETS = {
  USERS: 'Users',
  TRANSACTIONS: 'Transactions',
  CARDS: 'Cards',
  FAILS: 'CardFails',
};

function doPost(e) {
  const req = JSON.parse(e.postData.contents || '{}');
  const path = e.parameter.path || e.parameter.p || '';
  try {
    switch (path) {
      case '/getUser': return reply(ok(getUser(req.emailOrUsername)));
      case '/getTransactions': return reply(ok(getTransactions(req.account)));
      case '/transfer': return reply(ok(transfer(req.fromAccount, req.toAccount, +req.amount, req.memo)));
      case '/deposit': return adminGuard(req.adminToken), reply(ok(deposit(req.account, +req.amount, req.memo)));
      case '/withdraw': return adminGuard(req.adminToken), reply(ok(withdraw(req.account, +req.amount, req.memo)));
      case '/createCard': return adminGuard(req.adminToken), reply(ok(createCard(req.userId, req.nameOnCard, req.pinHash)));
      case '/chargeCard': return reply(chargeCard(req.cardNumber, req.cvv, req.pin, +req.amount, req.description));
      case '/admin/listCards': return adminGuard(req.adminToken), reply(ok(listCards(req.userId)));
      case '/admin/updateCard': return adminGuard(req.adminToken), reply(ok(updateCard(req.cardNumber, req.patch)));
      case '/admin/unlockCard': return adminGuard(req.adminToken), reply(ok(unlockCard(req.cardNumber, !!req.permanent)));
      default: return reply(err('Unknown path: ' + path));
    }
  } catch (e) {
    return reply(err(e.message || String(e)));
  }
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function ok(data) { return { data }; }
function err(error) { return { error }; }
function adminGuard(token) { if (token !== ADMIN_TOKEN) throw new Error('Forbidden'); }

function ss() { return SpreadsheetApp.openById(SPREADSHEET_ID); }

function ensureSheets() {
  const s = ss();
  const names = s.getSheets().map(sh => sh.getName());
  if (names.indexOf(SHEETS.USERS) < 0) s.insertSheet(SHEETS.USERS).appendRow(['id','firstName','lastName','username','email','accountNumber','balance','isAdmin','createdAt']);
  if (names.indexOf(SHEETS.TRANSACTIONS) < 0) s.insertSheet(SHEETS.TRANSACTIONS).appendRow(['id','account','type','amount','counterparty','memo','createdAt','balanceAfter']);
  if (names.indexOf(SHEETS.CARDS) < 0) s.insertSheet(SHEETS.CARDS).appendRow(['cardNumber','userId','nameOnCard','cvv','pinHash','validUntil','status','failedCount','blockedUntil']);
  if (names.indexOf(SHEETS.FAILS) < 0) s.insertSheet(SHEETS.FAILS).appendRow(['cardNumber','failedAt','reason']);
}

function getUser(emailOrUsername) {
  ensureSheets();
  const sh = ss().getSheetByName(SHEETS.USERS);
  const rows = sh.getDataRange().getValues();
  const head = rows.shift();
  const idx = {
    email: head.indexOf('email'),
    username: head.indexOf('username'),
  };
  for (let r of rows) {
    if (r[idx.email] == emailOrUsername || r[idx.username] == emailOrUsername) {
      const o = {};
      head.forEach((h,i)=>o[h]=r[i]);
      return o;
    }
  }
  return null;
}

function getTransactions(account) {
  ensureSheets();
  const sh = ss().getSheetByName(SHEETS.TRANSACTIONS);
  const rows = sh.getDataRange().getValues();
  const head = rows.shift();
  return rows.filter(r => r[head.indexOf('account')] == account).map(r => {
    const o = {}; head.forEach((h,i)=>o[h]=r[i]); return o;
  }).reverse();
}

function findUserByAccount(account) {
  const sh = ss().getSheetByName(SHEETS.USERS);
  const rows = sh.getDataRange().getValues();
  const head = rows.shift();
  const iAcc = head.indexOf('accountNumber'), iBal = head.indexOf('balance');
  for (let ri=0; ri<rows.length; ri++) if (rows[ri][iAcc]==account) return { ri: ri+2, row: rows[ri], head, iBal };
  throw new Error('Account not found');
}

function addTx(account, type, amount, counterparty, memo, balanceAfter) {
  const sh = ss().getSheetByName(SHEETS.TRANSACTIONS);
  const id = 'TX-' + Date.now();
  sh.appendRow([id, account, type, amount, counterparty || '', memo || '', new Date(), balanceAfter]);
  return id;
}

function deposit(account, amount, memo) {
  if (!(amount > 0)) throw new Error('Invalid amount');
  const u = findUserByAccount(account);
  const bal = Number(u.row[u.iBal]) + amount;
  ss().getSheetByName(SHEETS.USERS).getRange(u.ri, u.iBal+1).setValue(bal);
  const txId = addTx(account, 'DEPOSIT', amount, '', memo, bal);
  return { txId };
}

function withdraw(account, amount, memo) {
  if (!(amount > 0)) throw new Error('Invalid amount');
  const u = findUserByAccount(account);
  const cur = Number(u.row[u.iBal]);
  if (cur < amount) throw new Error('Insufficient funds');
  const bal = cur - amount;
  ss().getSheetByName(SHEETS.USERS).getRange(u.ri, u.iBal+1).setValue(bal);
  const txId = addTx(account, 'WITHDRAW', amount, '', memo, bal);
  return { txId };
}

function transfer(fromAccount, toAccount, amount, memo) {
  if (!(amount > 0)) throw new Error('Invalid amount');
  if (fromAccount === toAccount) throw new Error('Cannot transfer to same account');
  const from = findUserByAccount(fromAccount);
  const to = findUserByAccount(toAccount);
  const fromBal = Number(from.row[from.iBal]);
  if (fromBal < amount) throw new Error('Insufficient funds');
  const toBal = Number(to.row[to.iBal]);
  ss().getSheetByName(SHEETS.USERS).getRange(from.ri, from.iBal+1).setValue(fromBal - amount);
  ss().getSheetByName(SHEETS.USERS).getRange(to.ri, to.iBal+1).setValue(toBal + amount);
  const txId1 = addTx(fromAccount, 'TRANSFER_OUT', amount, toAccount, memo, fromBal - amount);
  const txId2 = addTx(toAccount, 'TRANSFER_IN', amount, fromAccount, memo, toBal + amount);
  return { txId: txId1 };
}

// Credit cards
function randomDigits(n) { return Array.from({length:n}, _=> Math.floor(Math.random()*10)).join(''); }

function createCard(userId, nameOnCard, pinHash) {
  ensureSheets();
  const sh = ss().getSheetByName(SHEETS.CARDS);
  const cardNumber = '5' + randomDigits(15);
  const cvv = randomDigits(3);
  const validUntil = new Date(); validUntil.setFullYear(validUntil.getFullYear() + 10);
  sh.appendRow([cardNumber, userId, nameOnCard, cvv, pinHash, validUntil, 'ACTIVE', 0, '']);
  return { cardNumber };
}

function listCards(userId) {
  const sh = ss().getSheetByName(SHEETS.CARDS);
  const rows = sh.getDataRange().getValues(); const head = rows.shift();
  return rows.filter(r => !userId || r[head.indexOf('userId')] == userId).map(r => { const o={}; head.forEach((h,i)=>o[h]=r[i]); return o; });
}

function updateCard(cardNumber, patch) {
  const sh = ss().getSheetByName(SHEETS.CARDS);
  const rows = sh.getDataRange().getValues(); const head = rows.shift();
  const idx = rows.findIndex(r => r[head.indexOf('cardNumber')] == cardNumber);
  if (idx < 0) throw new Error('Card not found');
  const ri = idx + 2;
  for (const [key,val] of Object.entries(patch)) {
    const ci = head.indexOf(key); if (ci >= 0) sh.getRange(ri, ci+1).setValue(val);
  }
}

function unlockCard(cardNumber, permanent) {
  const sh = ss().getSheetByName(SHEETS.CARDS);
  const rows = sh.getDataRange().getValues(); const head = rows.shift();
  const idx = rows.findIndex(r => r[head.indexOf('cardNumber')] == cardNumber);
  if (idx < 0) throw new Error('Card not found');
  const ri = idx + 2;
  sh.getRange(ri, head.indexOf('status')+1).setValue(permanent ? 'ACTIVE' : 'ACTIVE');
  sh.getRange(ri, head.indexOf('failedCount')+1).setValue(0);
  sh.getRange(ri, head.indexOf('blockedUntil')+1).setValue('');
}

function chargeCard(cardNumber, cvv, pin, amount, description) {
  ensureSheets();
  const sh = ss().getSheetByName(SHEETS.CARDS);
  const rows = sh.getDataRange().getValues(); const head = rows.shift();
  const iNum = head.indexOf('cardNumber'), iCVV = head.indexOf('cvv'), iHash = head.indexOf('pinHash');
  const iValid = head.indexOf('validUntil'), iStatus = head.indexOf('status'), iFails=head.indexOf('failedCount'), iBlock=head.indexOf('blockedUntil');
  const idx = rows.findIndex(r => r[iNum] == cardNumber);
  if (idx < 0) return err('Card not found');
  const ri = idx+2; const row = rows[idx];
  const now = new Date();
  if (row[iStatus] == 'PERM_LOCK') return err('Card permanently locked');
  if (row[iBlock] && new Date(row[iBlock]) > now) return err('Card temporarily blocked. Try later.');
  if (new Date(row[iValid]) < now) return err('Card expired');
  if (String(row[iCVV]) !== String(cvv)) return onFail(ri, cardNumber, 'CVV mismatch');
  const hash = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, pin).reduce((s,b)=>s+('0'+(b&0xff).toString(16)).slice(-2),'');
  if (hash !== String(row[iHash])) return onFail(ri, cardNumber, 'PIN mismatch');
  // success: reset failures
  sh.getRange(ri, iFails+1).setValue(0);
  sh.getRange(ri, iBlock+1).setValue('');
  // Only allow purchases of your product (no merchant routing here; simply record auth)
  const authCode = 'AUTH-' + Math.floor(Math.random()*1e8).toString().padStart(8,'0');
  // Append a transaction row for auditing (account left blank because this is a card)
  const txId = 'TX-' + Date.now();
  ss().getSheetByName(SHEETS.TRANSACTIONS).appendRow([txId, '', 'CARD_CHARGE', amount, '', description || 'Product purchase', new Date(), '']);
  return ok({ authCode, txId });
}

function onFail(ri, cardNumber, reason) {
  const sh = ss().getSheetByName(SHEETS.CARDS);
  const fails = ss().getSheetByName(SHEETS.FAILS);
  const head = sh.getRange(1,1,1,sh.getLastColumn()).getValues()[0];
  const iFails = head.indexOf('failedCount'), iBlock=head.indexOf('blockedUntil'), iStatus=head.indexOf('status');
  const count = Number(sh.getRange(ri, iFails+1).getValue()) + 1;
  sh.getRange(ri, iFails+1).setValue(count);
  fails.appendRow([cardNumber, new Date(), reason]);
  if (count >= 3 && count < 4) {
    const until = new Date(); until.setHours(until.getHours()+12);
    sh.getRange(ri, iBlock+1).setValue(until);
    return err('Card blocked for 12 hours after 3 failed attempts');
  }
  if (count >= 4) {
    sh.getRange(ri, iStatus+1).setValue('PERM_LOCK');
    return err('Card permanently locked; contact admin');
  }
  return err('Authentication failed');
}