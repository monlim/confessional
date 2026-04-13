const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());

// In-memory store
const confessions = new Map();
const queue = []; // ordered list of approved confession IDs

const PORT = process.env.PORT || 3000;
// Set PUBLIC_URL to your Railway/tunnel domain so the QR code is correct.
const publicBase = process.env.PUBLIC_URL
  ? process.env.PUBLIC_URL.replace(/\/$/, '')
  : `http://localhost:${PORT}`;

// ── Routes ─────────────────────────────────────────────────────────────────

// Admin is the root
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
// Audience URL — encoded in QR code
app.get('/confess', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/display', (req, res) => res.sendFile(path.join(__dirname, 'public', 'display.html')));
// Static assets (socket.io client, etc.)
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/qr', async (req, res) => {
  const url = `${publicBase}/confess`;
  try {
    const qr = await QRCode.toDataURL(url, { width: 300, margin: 2, color: { dark: '#c8a96e', light: '#0a0a0a' } });
    res.json({ qr, url });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/submit', (req, res) => {
  const { text } = req.body;
  if (!text || text.trim().length === 0) {
    return res.status(400).json({ error: 'Text is required.' });
  }
  const trimmed = text.trim();
  if (trimmed.length > 500) {
    return res.status(400).json({ error: 'Too long — max 500 characters.' });
  }

  const id = uuidv4();
  const confession = {
    id,
    text: trimmed,
    fullText: `I regret ${trimmed}`,
    status: 'pending',
    timestamp: new Date().toISOString(),
  };

  confessions.set(id, confession);
  io.to('admin').emit('new_confession', confession);
  res.json({ success: true, id });
});

// Approval is now instant — TTS happens in the admin browser via Web Speech API
app.post('/api/approve/:id', (req, res) => {
  const confession = confessions.get(req.params.id);
  if (!confession) return res.status(404).json({ error: 'Not found.' });
  if (confession.status !== 'pending') return res.status(400).json({ error: 'Not pending.' });

  confession.status = 'queued';
  queue.push(confession.id);

  io.to('admin').emit('confession_updated', { id: confession.id, status: 'queued' });
  io.to('admin').emit('queue_updated', getQueue());
  res.json({ success: true });
});

app.post('/api/reject/:id', (req, res) => {
  const confession = confessions.get(req.params.id);
  if (!confession) return res.status(404).json({ error: 'Not found.' });

  confession.status = 'rejected';
  io.to('admin').emit('confession_updated', { id: confession.id, status: 'rejected' });
  confessions.delete(req.params.id);
  res.json({ success: true });
});

app.post('/api/display/:id', (req, res) => {
  const confession = confessions.get(req.params.id);
  if (!confession) return res.status(404).json({ error: 'Not found.' });

  io.to('display').emit('show_confession', { text: confession.fullText });
  res.json({ success: true });
});

app.post('/api/clear-display', (req, res) => {
  io.to('display').emit('clear_confession');
  res.json({ success: true });
});

app.post('/api/done/:id', (req, res) => {
  const confession = confessions.get(req.params.id);
  if (!confession) return res.status(404).json({ error: 'Not found.' });

  removeFromQueue(confession.id);
  confessions.delete(req.params.id);
  io.to('admin').emit('confession_updated', { id: confession.id, status: 'done' });
  io.to('admin').emit('queue_updated', getQueue());
  io.to('display').emit('clear_confession');
  res.json({ success: true });
});

app.post('/api/remove/:id', (req, res) => {
  const confession = confessions.get(req.params.id);
  if (!confession) return res.status(404).json({ error: 'Not found.' });

  removeFromQueue(confession.id);
  confessions.delete(req.params.id);
  io.to('admin').emit('confession_updated', { id: confession.id, status: 'removed' });
  io.to('admin').emit('queue_updated', getQueue());
  res.json({ success: true });
});

function removeFromQueue(id) {
  const idx = queue.indexOf(id);
  if (idx > -1) queue.splice(idx, 1);
}

function getQueue() {
  return queue.map(id => confessions.get(id)).filter(Boolean);
}

// ── Socket.io ───────────────────────────────────────────────────────────────

io.on('connection', (socket) => {
  socket.on('join_admin', () => {
    socket.join('admin');
    socket.emit('initial_state', {
      pending: [...confessions.values()].filter(c => c.status === 'pending'),
      queue: getQueue(),
    });
  });

  socket.on('join_display', () => {
    socket.join('display');
  });
});

// ── Start ───────────────────────────────────────────────────────────────────

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\nConfessional running:`);
  console.log(`  Admin    → http://localhost:${PORT}`);
  console.log(`  Display  → http://localhost:${PORT}/display`);
  console.log(`  Audience → ${publicBase}/confess\n`);
});
