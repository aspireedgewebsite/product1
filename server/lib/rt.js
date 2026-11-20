// Real-time layer: Socket.IO rooms per tenant+branch keep POS, kitchen, waiters and QR menu in sync.
let io = null;
module.exports = {
  setIO(i) { io = i; },
  room: (tenantId, branchId) => `t${tenantId}:b${branchId}`,
  emit(tenantId, branchId, event, data = {}) { if (io) io.to(`t${tenantId}:b${branchId}`).emit(event, data); },
  emitOrder(tenantId, branchId, orderId) { if (io) io.to(`t${tenantId}:b${branchId}`).emit('orders:changed', { orderId }); },
};
