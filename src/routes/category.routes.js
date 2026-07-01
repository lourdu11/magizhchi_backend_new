const express = require('express');
const r = express.Router();
const c = require('../controllers/category.controller');
const { protect, isAdmin, requirePermission } = require('../middlewares/auth');

r.get('/', c.getCategories);
r.get('/:slug', c.getCategory);
r.post('/', protect, requirePermission('categories'), c.createCategory);
r.put('/:id', protect, requirePermission('categories'), c.updateCategory);
r.delete('/:id', protect, requirePermission('categories'), c.deleteCategory);

module.exports = r;
