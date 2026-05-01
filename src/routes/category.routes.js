const express = require('express');
const r = express.Router();
const c = require('../controllers/category.controller');
const { protect, isAdmin } = require('../middlewares/auth');

r.get('/', c.getCategories);
r.get('/:slug', c.getCategory);
r.post('/', protect, isAdmin, c.createCategory);
r.put('/:id', protect, isAdmin, c.updateCategory);
r.delete('/:id', protect, isAdmin, c.deleteCategory);

module.exports = r;
