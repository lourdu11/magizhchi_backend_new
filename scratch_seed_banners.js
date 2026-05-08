const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config({ path: './.env' });
const Banner = require('./src/models/Banner');

const HERO_SLIDES = [
  {
    title: 'Modern Gentleman',
    subtitle: "Tamil Nadu's destination for MAGIZHCHI GARMENTS. Discover the art of perfect tailoring.",
    link: '/collections',
    desktopImage: 'https://ik.imagekit.io/Lourdu/magizhchi_garments/maghchi%20image/IMG-20251126-WA0048.jpg?updatedAt=1772379292131',
    displayOrder: 1,
    isActive: true,
    type: 'hero'
  },
  {
    title: 'The Formal Standard',
    subtitle: 'From boardroom to weddings. Look your absolute best with our premium formal range.',
    link: '/collections/formals',
    desktopImage: 'https://ik.imagekit.io/Lourdu/magizhchi_garments/maghchi%20image/IMG-20251126-WA0097.jpg?updatedAt=1772379295602',
    displayOrder: 2,
    isActive: true,
    type: 'hero'
  },
  {
    title: 'Casual Comfort',
    subtitle: 'Elevate your daily style with our range of premium t-shirts and comfort wear.',
    link: '/collections/t-shirts',
    desktopImage: 'https://ik.imagekit.io/Lourdu/magizhchi_garments/maghchi%20image/IMG-20251126-WA0085.jpg?updatedAt=1772379294664',
    displayOrder: 3,
    isActive: true,
    type: 'hero'
  },
  {
    title: 'Timeless Denim',
    subtitle: 'Classic jeans that fit perfectly and last forever. The foundation of every wardrobe.',
    link: '/collections/jeans',
    desktopImage: 'https://ik.imagekit.io/Lourdu/magizhchi_garments/maghchi%20image/IMG-20251126-WA0054.jpg?updatedAt=1772379274925',
    displayOrder: 4,
    isActive: true,
    type: 'hero'
  }
];

async function seed() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to DB');
    
    // Check if banners exist
    const count = await Banner.countDocuments();
    if (count <= 1) {
      console.log('Seeding default banners...');
      await Banner.insertMany(HERO_SLIDES);
      console.log('Banners seeded successfully.');
    } else {
      console.log('Banners already exist, skipping seed.');
    }
  } catch (error) {
    console.error('Seed error:', error);
  } finally {
    process.exit(0);
  }
}
seed();
