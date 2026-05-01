const Category = require('../models/Category');
const ApiResponse = require('../utils/apiResponse');
const slugify = require('slugify');

exports.getCategories = async (req, res, next) => {
  try {
    const categories = await Category.find({ isActive: true }).sort({ displayOrder: 1 });
    return ApiResponse.success(res, { categories });
  } catch (error) { next(error); }
};

exports.getCategory = async (req, res, next) => {
  try {
    const category = await Category.findOne({ slug: req.params.slug, isActive: true });
    if (!category) return ApiResponse.notFound(res, 'Category not found');
    return ApiResponse.success(res, { category });
  } catch (error) { next(error); }
};

exports.createCategory = async (req, res, next) => {
  try {
    const data = req.body;
    if (!data.slug) data.slug = slugify(data.name, { lower: true, strict: true });
    const category = await Category.create(data);
    return ApiResponse.created(res, { category });
  } catch (error) { next(error); }
};

exports.updateCategory = async (req, res, next) => {
  try {
    const category = await Category.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!category) return ApiResponse.notFound(res, 'Category not found');
    return ApiResponse.success(res, { category });
  } catch (error) { next(error); }
};

exports.deleteCategory = async (req, res, next) => {
  try {
    await Category.findByIdAndUpdate(req.params.id, { isActive: false });
    return ApiResponse.success(res, null, 'Category deleted');
  } catch (error) { next(error); }
};
