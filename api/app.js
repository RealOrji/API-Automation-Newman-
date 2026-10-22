// A small Bookstore REST API used as the "system under test".
// It keeps data in memory so every run starts from the same known state.
import express from 'express';
import crypto from 'node:crypto';

const DEMO_USER = { username: 'admin', password: 'password123' };
const ISBN_PATTERN = /^\d{13}$/;

const seedBooks = () => [
  { id: 1, title: 'Clean Code', author: 'Robert C. Martin', isbn: '9780132350884', price: 32.99, inStock: true },
  { id: 2, title: 'The Pragmatic Programmer', author: 'Andrew Hunt', isbn: '9780135957059', price: 41.5, inStock: true },
  { id: 3, title: 'Refactoring', author: 'Martin Fowler', isbn: '9780134757599', price: 38.0, inStock: false },
];

function validateBook(body, { partial = false } = {}) {
  const errors = [];
  const has = (field) => body[field] !== undefined;

  if (!partial || has('title')) {
    if (typeof body.title !== 'string' || body.title.trim() === '') errors.push('title is required and must be a non-empty string');
  }
  if (!partial || has('author')) {
    if (typeof body.author !== 'string' || body.author.trim() === '') errors.push('author is required and must be a non-empty string');
  }
  if (!partial || has('isbn')) {
    if (typeof body.isbn !== 'string' || !ISBN_PATTERN.test(body.isbn)) errors.push('isbn is required and must be exactly 13 digits');
  }
  if (!partial || has('price')) {
    if (typeof body.price !== 'number' || Number.isNaN(body.price) || body.price < 0) errors.push('price is required and must be a number >= 0');
  }
  if (has('inStock') && typeof body.inStock !== 'boolean') errors.push('inStock must be a boolean');

  return errors;
}

export function createApp() {
  const app = express();
  const tokens = new Set();
  let books = seedBooks();
  let nextId = books.length + 1;

  app.use(express.json());

  const requireAuth = (req, res, next) => {
    const header = req.get('Authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token || !tokens.has(token)) {
      return res.status(401).json({ error: 'Unauthorized', details: ['A valid Bearer token is required'] });
    }
    next();
  };

  const findBook = (req, res, next) => {
    const book = books.find((b) => b.id === Number(req.params.id));
    if (!book) return res.status(404).json({ error: 'Not Found', details: [`Book ${req.params.id} does not exist`] });
    req.book = book;
    next();
  };

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  app.post('/auth/token', (req, res) => {
    const { username, password } = req.body ?? {};
    if (username !== DEMO_USER.username || password !== DEMO_USER.password) {
      return res.status(401).json({ error: 'Unauthorized', details: ['Invalid username or password'] });
    }
    const token = crypto.randomBytes(24).toString('hex');
    tokens.add(token);
    res.status(201).json({ token, tokenType: 'Bearer', expiresIn: 3600 });
  });

  app.get('/books', (req, res) => {
    const { author } = req.query;
    const limit = req.query.limit === undefined ? undefined : Number(req.query.limit);
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      return res.status(400).json({ error: 'Bad Request', details: ['limit must be a positive integer'] });
    }
    let result = books;
    if (author) result = result.filter((b) => b.author.toLowerCase().includes(String(author).toLowerCase()));
    if (limit) result = result.slice(0, limit);
    res.json({ count: result.length, data: result });
  });

  app.get('/books/:id', findBook, (req, res) => {
    res.json(req.book);
  });

  app.post('/books', requireAuth, (req, res) => {
    const errors = validateBook(req.body ?? {});
    if (errors.length) return res.status(400).json({ error: 'Bad Request', details: errors });
    if (books.some((b) => b.isbn === req.body.isbn)) {
      return res.status(409).json({ error: 'Conflict', details: [`A book with isbn ${req.body.isbn} already exists`] });
    }
    const { title, author, isbn, price, inStock = true } = req.body;
    const book = { id: nextId++, title, author, isbn, price, inStock };
    books.push(book);
    res.status(201).location(`/books/${book.id}`).json(book);
  });

  app.patch('/books/:id', requireAuth, findBook, (req, res) => {
    const errors = validateBook(req.body ?? {}, { partial: true });
    if (errors.length) return res.status(400).json({ error: 'Bad Request', details: errors });
    const { title, author, isbn, price, inStock } = req.body;
    Object.assign(req.book, Object.fromEntries(
      Object.entries({ title, author, isbn, price, inStock }).filter(([, v]) => v !== undefined),
    ));
    res.json(req.book);
  });

  app.delete('/books/:id', requireAuth, findBook, (req, res) => {
    books = books.filter((b) => b.id !== req.book.id);
    res.status(204).end();
  });

  // Test-only helper so a suite can start from the seed data. Disabled in production.
  if (process.env.NODE_ENV !== 'production') {
    app.post('/test/reset', (req, res) => {
      books = seedBooks();
      nextId = books.length + 1;
      res.status(204).end();
    });
  }

  app.use((req, res) => {
    res.status(404).json({ error: 'Not Found', details: [`No route for ${req.method} ${req.path}`] });
  });

  // Malformed JSON bodies and any unexpected error end up here.
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Bad Request', details: ['Request body is not valid JSON'] });
    }
    console.error(err);
    res.status(500).json({ error: 'Internal Server Error', details: [] });
  });

  return app;
}
