'use strict';
const {createHash} = require('node:crypto');
class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const validKey = (v) => typeof v === 'string' && v.length > 0 && v.length <= 200 && !/[.#$\[\]/]/.test(v);
function key(v, label) { if (!validKey(v)) throw new ApiError(400, `Invalid ${label}.`); return v; }
function text(v, max, label, empty = false) {
  if (typeof v !== 'string' || (!empty && !v.trim()) || v.trim().length > max) throw new ApiError(400, `Invalid ${label} (maximum ${max} characters).`);
  return v.trim();
}
function createService({db, auth, messaging}) {
  function admin(user) { if (user.customClaims?.admin !== true) throw new ApiError(403, 'Administrator access required.'); }
  const stamp = () => Date.now();
  const pushMessage = (row) => ({notification: {title: row.title, body: row.body}, data: row.data,
    android: {priority: 'high', ttl: 86400000, notification: {channelId: 'athenaeum_updates', icon: 'ic_stat_book', sound: 'default'}},
    apns: {headers: {'apns-priority': '10'}, payload: {aps: {sound: 'default'}}}});
  function queueRow(title, body, data, uid = null) { return {title, body, data, uid, createdAt: stamp()}; }
  function inboxRow(row) { return {title: row.title, body: row.body, ...row.data, createdAt: row.createdAt}; }
  async function deliver(id) {
    const ref = db.ref(`pushQueue/${id}`);
    const row = (await ref.get()).val();
    if (!row || row.sentAt) return {push: 'already-sent'};
    try {
      if (!row.uid) {
        await messaging.send({topic: 'athenaeum_readers', ...pushMessage(row)});
      } else {
        const user = await auth.getUser(row.uid).catch((e) => {
          if (e.code === 'auth/user-not-found') return null; throw e;
        });
        if (user && !user.disabled) {
          const tokens = Object.keys((await db.ref(`deviceTokens/${row.uid}`).get()).val() || {});
          let failed = false;
          for (let i = 0; i < tokens.length; i += 500) {
            const batch = tokens.slice(i, i + 500);
            const response = await messaging.sendEachForMulticast({tokens: batch, ...pushMessage(row)});
            for (let j = 0; j < response.responses.length; j++) {
              const result = response.responses[j];
              if (!result.success) {
                if (['messaging/invalid-registration-token', 'messaging/registration-token-not-registered'].includes(result.error?.code)) {
                  await db.ref(`deviceTokens/${row.uid}/${batch[j]}`).remove();
                } else { failed = true; }
              }
            }
          }
          if (failed) throw new Error('Some push deliveries failed.');
        }
      }
      await ref.update({sentAt: stamp(), lastError: null});
      return {push: 'sent'};
    } catch (error) {
      // Mutations already committed remain successful. Admin can retry pending push.
      await ref.update({lastError: String(error.code || 'delivery-failed'), lastAttemptAt: stamp()}).catch(() => {});
      return {push: 'pending', warning: 'Saved successfully; push delivery is pending. Admin can retry notifications.'};
    }
  }
  async function manageUser(user, input) {
    admin(user);
    const uid = key(input.uid, 'user'), action = input.action;
    if (!['edit', 'disable', 'enable', 'delete'].includes(action)) throw new ApiError(400, 'Invalid account action.');
    const target = await auth.getUser(uid);
    if (uid === user.uid || target.customClaims?.admin === true) throw new ApiError(403, 'Manage administrator accounts in Firebase Console or with the trusted script.');
    if (action === 'edit') {
      const name = text(input.name, 80, 'name');
      const shippingAddress = text(input.shippingAddress ?? '', 500, 'address', true);
      const paymentMethod = text(input.paymentMethod ?? '', 100, 'payment preference', true);
      await auth.updateUser(uid, {displayName: name});
      await db.ref(`users/${uid}`).update({name, shippingAddress, paymentMethod, updatedAt: stamp()});
    } else if (action === 'delete') {
      await auth.deleteUser(uid);
      await db.ref().update({[`users/${uid}`]: null, [`carts/${uid}`]: null, [`wishlists/${uid}`]: null,
        [`deviceTokens/${uid}`]: null, [`notifications/${uid}`]: null});
    } else {
      const disabled = action === 'disable';
      await db.ref(`users/${uid}`).update({disabled, updatedAt: stamp()});
      await auth.updateUser(uid, {disabled});
      if (disabled) await auth.revokeRefreshTokens(uid);
    }
    return {success: true};
  }
  async function announce(user, input) {
    admin(user);
    const title = text(input.title, 100, 'title'), body = text(input.body, 500, 'message');
    const id = db.ref('announcements').push().key;
    const row = queueRow(title, body, {type: 'announcement', notificationId: id});
    await db.ref().update({[`announcements/${id}`]: inboxRow(row), [`pushQueue/${id}`]: row});
    return {id, ...await deliver(id)};
  }
  function bookInput(input) {
    const b = input.book;
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw new ApiError(400, 'Book required.');
    const result = {title: text(b.title, 200, 'title'), author: text(b.author, 200, 'author'),
      genre: text(b.genre, 100, 'genre'), description: text(b.description ?? '', 10000, 'description', true),
      imageUrl: text(b.imageUrl ?? '', 1500000, 'image', true)};
    for (const field of ['price', 'rating', 'stock', 'year']) {
      if (typeof b[field] !== 'number' || !Number.isFinite(b[field])) throw new ApiError(400, `Invalid ${field}.`);
      result[field] = b[field];
    }
    if (result.price < 0 || result.price > 1000000 || result.rating < 0 || result.rating > 5 ||
        !Number.isInteger(result.stock) || result.stock < 0 || !Number.isInteger(result.year) || result.year < 1 || result.year > 9999) {
      throw new ApiError(400, 'Invalid price, rating, stock or year.');
    }
    result.bestseller = b.bestseller === true; result.newArrival = b.newArrival === true;
    return result;
  }
  async function saveBook(user, input) {
    admin(user);
    const id = key(input.id, 'book ID'), book = bookInput(input), mode = input.mode;
    if (!['add', 'update'].includes(mode)) throw new ApiError(400, 'Invalid book mode.');
    const noticeId = db.ref('announcements').push().key;
    const row = queueRow(mode === 'add' ? 'New book added' : 'Book updated',
      `${book.title} by ${book.author}`, {type: 'book', bookId: id, notificationId: noticeId});
    let reason;
    const result = await db.ref().transaction((root) => {
      if (!root) return {};
      root.books ||= {};
      const existing = root.books[id];
      if (mode === 'add' && existing) { reason = 'Book ID already exists.'; return; }
      if (mode === 'update' && !existing) { reason = 'Book no longer exists.'; return; }
      root.books[id] = book;
      root.announcements ||= {}; root.announcements[noticeId] = inboxRow(row);
      root.pushQueue ||= {}; root.pushQueue[noticeId] = row;
      return root;
    });
    if (!result.committed || !result.snapshot.child(`books/${id}`).exists()) throw new ApiError(409, reason || 'Please retry saving the book.');
    return {id, ...await deliver(noticeId)};
  }
  async function deleteBook(user, input) {
    admin(user); const id = key(input.id, 'book');
    const noticeId = db.ref('announcements').push().key;
    const result = await db.ref().transaction((root) => {
      if (!root) return {};
      const book = root.books?.[id];
      if (!book) return;
      const row = queueRow('Catalog update', `${book.title} has been removed from the catalog.`,
        {type: 'book', bookId: id, notificationId: noticeId});
      delete root.books[id];
      root.announcements ||= {}; root.announcements[noticeId] = inboxRow(row);
      root.pushQueue ||= {}; root.pushQueue[noticeId] = row;
      return root;
    });
    if (!result.committed || !result.snapshot.child(`pushQueue/${noticeId}`).exists()) throw new ApiError(404, 'Book no longer exists.');
    return {success: true, ...await deliver(noticeId)};
  }
  async function createOrder(user, input) {
    const requested = input.items;
    if (!Array.isArray(requested) || !requested.length || requested.length > 100) throw new ApiError(400, 'Choose 1 to 100 books.');
    const chosen = new Map();
    for (const item of requested) {
      key(item.bookId, 'book');
      if (!Number.isInteger(item.qty) || item.qty < 1 || item.qty > 100 || chosen.has(item.bookId)) throw new ApiError(400, 'Invalid or duplicate quantity.');
      chosen.set(item.bookId, item.qty);
    }
    const requestId = text(input.requestId, 100, 'checkout request ID');
    const hash = createHash('sha256').update(`${user.uid}:${requestId}`).digest('hex');
    const orderId = `order_${hash}`, noticeId = `placed_${hash}`;
    const signature = createHash('sha256').update(JSON.stringify([...chosen].sort())).digest('hex');
    let problem = 'Please retry checkout.';
    const result = await db.ref().transaction((root) => {
      if (!root) return {};
      if (root.orders?.[orderId]) {
        if (root.orders[orderId].requestSignature !== signature) { problem = 'Checkout ID already used with different items.'; return; }
        return root;
      }
      if (!root.users?.[user.uid] || root.users[user.uid].disabled === true) { problem = 'Account unavailable.'; return; }
      let subtotalCents = 0; const items = [];
      for (const [bookId, qty] of chosen) {
        const b = root.books?.[bookId];
        if (!b || !Number.isInteger(b.stock) || b.stock < qty) { problem = `${b?.title || bookId}: insufficient stock.`; return; }
        if (typeof b.price !== 'number' || !Number.isFinite(b.price) || b.price < 0 || b.price > 1000000) { problem = 'Invalid catalog price.'; return; }
        subtotalCents += Math.round(b.price * 100) * qty;
        items.push({bookId, qty, title: b.title, author: b.author, price: b.price});
      }
      const taxCents = Math.round(subtotalCents * 0.08);
      const profile = root.users[user.uid];
      const order = {userId: user.uid, items, subtotal: subtotalCents / 100, tax: taxCents / 100,
        total: (subtotalCents + taxCents) / 100, status: 'Placed', createdAt: stamp(),
        shippingAddress: profile.shippingAddress || '', paymentMethod: profile.paymentMethod || '', requestSignature: signature};
      for (const [id, qty] of chosen) root.books[id].stock -= qty;
      root.orders ||= {}; root.orders[orderId] = order;
      if (root.carts) delete root.carts[user.uid];
      const row = queueRow('Order update', `Order ${orderId}: Placed`, {type: 'order', orderId, userId: user.uid}, user.uid);
      root.notifications ||= {}; root.notifications[user.uid] ||= {}; root.notifications[user.uid][noticeId] = inboxRow(row);
      root.pushQueue ||= {}; root.pushQueue[noticeId] = row;
      return root;
    });
    const order = result.snapshot.child(`orders/${orderId}`).val();
    if (!result.committed || !order) throw new ApiError(409, problem);
    return {orderId, total: order.total, ...await deliver(noticeId)};
  }
  async function updateOrderStatus(user, input) {
    admin(user); const id = key(input.orderId, 'order');
    const status = input.status;
    if (!['Placed', 'Processing', 'Dispatched', 'Delivered'].includes(status)) throw new ApiError(400, 'Invalid status.');
    const noticeId = db.ref('notifications').push().key;
    let unchanged = false;
    const result = await db.ref().transaction((root) => {
      if (!root) return {};
      const order = root.orders?.[id];
      if (!order) return;
      unchanged = order.status === status;
      if (unchanged) return root;
      order.status = status; order.updatedAt = stamp();
      const row = queueRow('Order update', `Order ${id}: ${status}`, {type: 'order', orderId: id, userId: order.userId}, order.userId);
      root.notifications ||= {}; root.notifications[order.userId] ||= {}; root.notifications[order.userId][noticeId] = inboxRow(row);
      root.pushQueue ||= {}; root.pushQueue[noticeId] = row;
      return root;
    });
    if (!result.committed || !result.snapshot.child(`orders/${id}`).exists()) throw new ApiError(404, 'Order not found.');
    return {success: true, ...unchanged ? {push: 'unchanged'} : await deliver(noticeId)};
  }
  async function likeReview(user, input) {
    const bookId = key(input.bookId, 'book'), reviewId = key(input.reviewId, 'review');
    const result = await db.ref(`reviews/${bookId}/${reviewId}`).transaction((review) => {
      if (!review) return null;
      review.likedBy ||= {};
      if (!review.likedBy[user.uid]) { review.likedBy[user.uid] = true; review.likes = (Number(review.likes) || 0) + 1; }
      return review;
    });
    if (!result.snapshot.exists()) throw new ApiError(404, 'Review not found.');
    return {success: true};
  }
  async function retryNotifications(user) {
    admin(user);
    // Bounded manual retry; no paid Cloud Functions or background cron required.
    const raw = (await db.ref('pushQueue').orderByChild('sentAt').equalTo(null).limitToFirst(20).get()).val() || {};
    const results = [];
    for (const id of Object.keys(raw)) results.push({id, ...await deliver(id)});
    return {results};
  }
  const actions = {manageUser, sendAnnouncement: announce, saveBook, deleteBook, createOrder, updateOrderStatus, likeReview, retryNotifications};
  return {async execute(action, user, data = {}) {
    if (!actions[action]) throw new ApiError(404, 'Unknown API action.');
    return actions[action](user, data);
  }};
}
module.exports = {createService, ApiError};
