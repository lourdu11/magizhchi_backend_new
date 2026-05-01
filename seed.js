require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('./src/config/db');
const Category = require('./src/models/Category');
const Product = require('./src/models/Product');
const User = require('./src/models/User');
const Settings = require('./src/models/Settings');

const CATEGORIES = [
  { name: 'Shirts', slug: 'shirts', description: 'Formal and casual shirts', displayOrder: 1 },
  { name: 'T-Shirts', slug: 't-shirts', description: 'Everyday comfort tees', displayOrder: 2 },
  { name: 'Jeans', slug: 'jeans', description: 'Slim and regular fit jeans', displayOrder: 3 },
  { name: 'Trousers', slug: 'trousers', description: 'Formal and casual trousers', displayOrder: 4 },
  { name: 'Formals', slug: 'formals', description: 'Office ready formal wear', displayOrder: 5 },
];

const SAMPLE_PRODUCTS = [
  {
    name: 'Classic White Oxford Shirt',
    slug: 'classic-white-oxford-shirt',
    sku: 'MGZ-SHT-001',
    description: 'A timeless white Oxford shirt crafted from 100% premium cotton. Perfect for office and formal occasions.',
    shortDescription: 'Premium Oxford cotton formal shirt',
    sellingPrice: 1299,
    discountedPrice: 999,
    discountPercentage: 23,
    costPrice: 450,
    brand: 'Magizhchi',
    hsnCode: '6205',
    images: [
      'https://images.unsplash.com/photo-1596755094514-f87e34085b2c?w=600&q=80',
      'https://images.unsplash.com/photo-1602810316498-ab67cf68c8e1?w=600&q=80',
    ],
    variants: [
      { size: 'S', color: 'White', stock: 15 },
      { size: 'M', color: 'White', stock: 25 },
      { size: 'L', color: 'White', stock: 20 },
      { size: 'XL', color: 'White', stock: 10 },
      { size: 'S', color: 'Light Blue', stock: 12 },
      { size: 'M', color: 'Light Blue', stock: 18 },
      { size: 'L', color: 'Light Blue', stock: 15 },
    ],
    specifications: { fabric: '100% Cotton', fit: 'Regular Fit', occasion: 'Formal/Office', careInstructions: 'Machine wash cold, iron on medium' },
    tags: ['shirt', 'formal', 'white', 'oxford', 'office'],
    isFeatured: true, isNewArrival: true, isBestSeller: false, isActive: true,
    lowStockThreshold: 5, gstPercentage: 12, salesCount: 45,
    ratings: { average: 4.5, count: 28 },
    categorySlug: 'shirts',
  },
  {
    name: 'Navy Blue Slim Fit Shirt',
    slug: 'navy-blue-slim-fit-shirt',
    sku: 'MGZ-SHT-002',
    description: 'A stylish navy blue slim fit shirt for the modern man. Crafted with premium cotton blend for all-day comfort.',
    shortDescription: 'Slim fit navy blue premium shirt',
    sellingPrice: 1499,
    discountedPrice: 1199,
    discountPercentage: 20,
    costPrice: 520,
    brand: 'Magizhchi',
    hsnCode: '6205',
    images: [
      'https://images.unsplash.com/photo-1607345366928-199ea26cfe3e?w=600&q=80',
      'https://images.unsplash.com/photo-1598033129183-c4f50c736f10?w=600&q=80',
    ],
    variants: [
      { size: 'S', color: 'Navy Blue', stock: 10 },
      { size: 'M', color: 'Navy Blue', stock: 20 },
      { size: 'L', color: 'Navy Blue', stock: 18 },
      { size: 'XL', color: 'Navy Blue', stock: 8 },
      { size: 'XXL', color: 'Navy Blue', stock: 5 },
    ],
    specifications: { fabric: 'Cotton Blend', fit: 'Slim Fit', occasion: 'Casual/Smart Casual' },
    tags: ['shirt', 'navy', 'slim fit', 'casual'],
    isFeatured: true, isNewArrival: false, isBestSeller: true, isActive: true,
    lowStockThreshold: 5, gstPercentage: 12, salesCount: 89,
    ratings: { average: 4.3, count: 52 },
    categorySlug: 'shirts',
  },
  {
    name: 'Solid Black Round Neck T-Shirt',
    slug: 'solid-black-round-neck-tshirt',
    sku: 'MGZ-TSH-001',
    description: 'A wardrobe essential — solid black round neck T-shirt in 100% combed cotton for everyday wear.',
    shortDescription: 'Premium combed cotton black tee',
    sellingPrice: 599,
    discountedPrice: 449,
    discountPercentage: 25,
    costPrice: 180,
    brand: 'Magizhchi',
    hsnCode: '6109',
    images: [
      'https://images.unsplash.com/photo-1521572163474-6864f9cf17ab?w=600&q=80',
      'https://images.unsplash.com/photo-1583743814966-8936f5b7be1a?w=600&q=80',
    ],
    variants: [
      { size: 'S', color: 'Black', stock: 30 },
      { size: 'M', color: 'Black', stock: 40 },
      { size: 'L', color: 'Black', stock: 35 },
      { size: 'XL', color: 'Black', stock: 25 },
      { size: 'XXL', color: 'Black', stock: 15 },
      { size: 'S', color: 'White', stock: 25 },
      { size: 'M', color: 'White', stock: 35 },
      { size: 'L', color: 'White', stock: 30 },
      { size: 'S', color: 'Grey', stock: 20 },
      { size: 'M', color: 'Grey', stock: 30 },
    ],
    specifications: { fabric: '100% Combed Cotton', fit: 'Regular Fit', occasion: 'Casual', weight: '180 GSM' },
    tags: ['tshirt', 'black', 'casual', 'cotton', 'basic'],
    isFeatured: true, isNewArrival: false, isBestSeller: true, isActive: true,
    lowStockThreshold: 10, gstPercentage: 12, salesCount: 210,
    ratings: { average: 4.6, count: 134 },
    categorySlug: 't-shirts',
  },
  {
    name: 'Graphic Print Oversized Tee',
    slug: 'graphic-print-oversized-tee',
    sku: 'MGZ-TSH-002',
    description: 'Trendy oversized graphic print tee for the style-conscious youth. Relaxed fit, premium quality.',
    shortDescription: 'Oversized graphic print T-shirt',
    sellingPrice: 799,
    discountedPrice: 649,
    discountPercentage: 19,
    costPrice: 250,
    brand: 'Magizhchi',
    hsnCode: '6109',
    images: [
      'https://images.unsplash.com/photo-1527719327859-c6ce80353573?w=600&q=80',
      'https://images.unsplash.com/photo-1576566588028-4147f3842f27?w=600&q=80',
    ],
    variants: [
      { size: 'S', color: 'Off White', stock: 15 },
      { size: 'M', color: 'Off White', stock: 22 },
      { size: 'L', color: 'Off White', stock: 18 },
      { size: 'XL', color: 'Off White', stock: 12 },
      { size: 'M', color: 'Beige', stock: 18 },
      { size: 'L', color: 'Beige', stock: 15 },
    ],
    specifications: { fabric: 'Cotton-Polyester Blend', fit: 'Oversized', occasion: 'Casual/Street' },
    tags: ['tshirt', 'oversized', 'graphic', 'streetwear', 'trendy'],
    isFeatured: false, isNewArrival: true, isBestSeller: false, isActive: true,
    lowStockThreshold: 5, gstPercentage: 12, salesCount: 67,
    ratings: { average: 4.2, count: 41 },
    categorySlug: 't-shirts',
  },
  {
    name: 'Dark Wash Slim Fit Jeans',
    slug: 'dark-wash-slim-fit-jeans',
    sku: 'MGZ-JNS-001',
    description: 'Premium dark wash slim fit jeans crafted from stretch denim for all-day comfort and style.',
    shortDescription: 'Dark wash slim fit stretch jeans',
    sellingPrice: 1999,
    discountedPrice: 1599,
    discountPercentage: 20,
    costPrice: 700,
    brand: 'Magizhchi',
    hsnCode: '6203',
    images: [
      'https://images.unsplash.com/photo-1542272454315-4c01d7abdf4a?w=600&q=80',
      'https://images.unsplash.com/photo-1473966968600-fa801b869a1a?w=600&q=80',
    ],
    variants: [
      { size: '28', color: 'Dark Blue', stock: 12 },
      { size: '30', color: 'Dark Blue', stock: 18 },
      { size: '32', color: 'Dark Blue', stock: 22 },
      { size: '34', color: 'Dark Blue', stock: 15 },
      { size: '36', color: 'Dark Blue', stock: 10 },
      { size: '30', color: 'Black', stock: 15 },
      { size: '32', color: 'Black', stock: 20 },
      { size: '34', color: 'Black', stock: 12 },
    ],
    specifications: { fabric: '98% Cotton 2% Elastane', fit: 'Slim Fit', occasion: 'Casual/Smart Casual', rise: 'Mid Rise' },
    tags: ['jeans', 'slim fit', 'dark wash', 'denim', 'stretch'],
    isFeatured: true, isNewArrival: true, isBestSeller: true, isActive: true,
    lowStockThreshold: 5, gstPercentage: 12, salesCount: 156,
    ratings: { average: 4.4, count: 89 },
    categorySlug: 'jeans',
  },
  {
    name: 'Classic Khaki Cotton Trousers',
    slug: 'classic-khaki-cotton-trousers',
    sku: 'MGZ-TRS-001',
    description: 'Versatile khaki cotton trousers that transition seamlessly from office to evening wear.',
    shortDescription: 'Classic khaki formal trousers',
    sellingPrice: 1599,
    discountedPrice: 1299,
    discountPercentage: 19,
    costPrice: 550,
    brand: 'Magizhchi',
    hsnCode: '6203',
    images: [
      'https://images.unsplash.com/photo-1624378439575-d8705ad7ae80?w=600&q=80',
      'https://images.unsplash.com/photo-1594938298603-c8148c4dae35?w=600&q=80',
    ],
    variants: [
      { size: '30', color: 'Khaki', stock: 15 },
      { size: '32', color: 'Khaki', stock: 20 },
      { size: '34', color: 'Khaki', stock: 18 },
      { size: '36', color: 'Khaki', stock: 12 },
      { size: '38', color: 'Khaki', stock: 8 },
      { size: '32', color: 'Navy', stock: 15 },
      { size: '34', color: 'Navy', stock: 18 },
      { size: '36', color: 'Navy', stock: 10 },
    ],
    specifications: { fabric: '100% Cotton', fit: 'Regular Fit', occasion: 'Office/Formal/Casual' },
    tags: ['trousers', 'khaki', 'formal', 'cotton', 'office'],
    isFeatured: false, isNewArrival: false, isBestSeller: true, isActive: true,
    lowStockThreshold: 5, gstPercentage: 12, salesCount: 98,
    ratings: { average: 4.3, count: 67 },
    categorySlug: 'trousers',
  },
  {
    name: 'Premium 3-Piece Formal Suit',
    slug: 'premium-3-piece-formal-suit',
    sku: 'MGZ-FRM-001',
    description: 'Elevate your formal game with this premium 3-piece suit — jacket, trouser, and waistcoat set.',
    shortDescription: 'Premium 3-piece formal suit set',
    sellingPrice: 8999,
    discountedPrice: 6999,
    discountPercentage: 22,
    costPrice: 3200,
    brand: 'Magizhchi',
    hsnCode: '6203',
    images: [
      'https://images.unsplash.com/photo-1594938298603-c8148c4dae35?w=600&q=80',
      'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=600&q=80',
    ],
    variants: [
      { size: '38', color: 'Charcoal', stock: 5 },
      { size: '40', color: 'Charcoal', stock: 8 },
      { size: '42', color: 'Charcoal', stock: 6 },
      { size: '44', color: 'Charcoal', stock: 4 },
      { size: '40', color: 'Navy Blue', stock: 6 },
      { size: '42', color: 'Navy Blue', stock: 5 },
    ],
    specifications: { fabric: 'Polyester-Viscose Blend', fit: 'Slim Fit', occasion: 'Formal/Wedding/Events' },
    tags: ['suit', 'formal', '3-piece', 'wedding', 'blazer'],
    isFeatured: true, isNewArrival: true, isBestSeller: false, isActive: true,
    lowStockThreshold: 2, gstPercentage: 12, salesCount: 23,
    ratings: { average: 4.7, count: 18 },
    categorySlug: 'formals',
  },
  {
    name: 'Polo Collar Cotton T-Shirt',
    slug: 'polo-collar-cotton-tshirt',
    sku: 'MGZ-TSH-003',
    description: 'Classic polo collar T-shirt in premium Pique cotton. Smart casual style for every occasion.',
    shortDescription: 'Premium Pique cotton polo shirt',
    sellingPrice: 899,
    discountedPrice: 749,
    discountPercentage: 17,
    costPrice: 280,
    brand: 'Magizhchi',
    hsnCode: '6109',
    images: [
      'https://images.unsplash.com/photo-1598033129183-c4f50c736f10?w=600&q=80',
      'https://images.unsplash.com/photo-1571945153237-4929e783af4a?w=600&q=80',
    ],
    variants: [
      { size: 'S', color: 'White', stock: 20 },
      { size: 'M', color: 'White', stock: 28 },
      { size: 'L', color: 'White', stock: 22 },
      { size: 'XL', color: 'White', stock: 15 },
      { size: 'S', color: 'Navy', stock: 18 },
      { size: 'M', color: 'Navy', stock: 25 },
      { size: 'L', color: 'Navy', stock: 20 },
      { size: 'S', color: 'Red', stock: 15 },
      { size: 'M', color: 'Red', stock: 22 },
    ],
    specifications: { fabric: '100% Pique Cotton', fit: 'Regular Fit', occasion: 'Smart Casual/Sports' },
    tags: ['polo', 'tshirt', 'collar', 'casual', 'pique'],
    isFeatured: false, isNewArrival: true, isBestSeller: true, isActive: true,
    lowStockThreshold: 8, gstPercentage: 12, salesCount: 178,
    ratings: { average: 4.5, count: 103 },
    categorySlug: 't-shirts',
  },
];

async function seed() {
  await connectDB();
  console.log('\n🌱 Starting database seed...\n');

  // Clear existing data
  await Promise.all([
    Category.deleteMany({}),
    Product.deleteMany({}),
    Settings.deleteMany({}),
  ]);
  console.log('🗑️  Cleared existing categories, products, settings');

  // Seed categories
  const cats = await Category.insertMany(CATEGORIES);
  console.log(`✅ Seeded ${cats.length} categories`);
  const catMap = {};
  cats.forEach(c => { catMap[c.slug] = c._id; });

  // Seed products
  let created = 0;
  for (const p of SAMPLE_PRODUCTS) {
    const { categorySlug, ...productData } = p;
    const catId = catMap[categorySlug];
    if (!catId) { console.log(`⚠️  Category not found: ${categorySlug}`); continue; }
    await Product.create({ ...productData, category: catId });
    created++;
  }
  console.log(`✅ Seeded ${created} products`);

  // Seed admin user
  const existingAdmin = await User.findOne({ email: 'admin@magizhchi.com' });
  if (!existingAdmin) {
    await User.create({
      name: 'Admin',
      email: 'admin@magizhchi.com',
      phone: '9999999999',
      password: 'Admin@1234',
      role: 'admin',
      isVerified: true,
    });
    console.log('✅ Admin user created: admin@magizhchi.com / Admin@1234');
  } else {
    console.log('ℹ️  Admin user already exists');
  }

  // Seed staff user
  const existingStaff = await User.findOne({ email: 'staff@magizhchi.com' });
  if (!existingStaff) {
    await User.create({
      name: 'Staff Member',
      email: 'staff@magizhchi.com',
      phone: '8888888888',
      password: 'Staff@1234',
      role: 'staff',
      isVerified: true,
    });
    console.log('✅ Staff user created: staff@magizhchi.com / Staff@1234');
  } else {
    console.log('ℹ️  Staff user already exists');
  }

  // Seed global settings
  try {
    await Settings.create({
      storeName: 'Magizhchi Garments',
      storeEmail: 'info@magizhchigarments.com',
      storePhone: '+91 99999 99999',
      storeAddress: {
        line1: '123 Gandhi Nagar',
        city: 'Tirunelveli',
        state: 'Tamil Nadu',
        pincode: '627001',
      },
      gstNumber: '33XXXXX0000X1Z5',
      shipping: { flatRate: 50, freeAbove: 999 },
      whatsappNumber: '919999999999',
    });
    console.log('✅ Global settings seeded');
  } catch (e) {
    console.log('ℹ️  Settings seed skipped (schema mismatch):', e.message.slice(0, 80));
  }


  console.log('\n🎉 Database seed complete!\n');
  console.log('─────────────────────────────────────');
  console.log('Admin Login  : admin@magizhchi.com');
  console.log('Password     : Admin@1234');
  console.log('Staff Login  : staff@magizhchi.com');
  console.log('Password     : Staff@1234');
  console.log('─────────────────────────────────────\n');

  process.exit(0);
}

seed().catch(err => {
  console.error('❌ Seed failed:', err);
  process.exit(1);
});
