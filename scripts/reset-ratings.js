const mongoose = require('mongoose');
const dotenv = require('dotenv');
dotenv.config();

async function resetRatings() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/magizhchi');
    console.log('Connected to DB');

    const Review = mongoose.model('Review', new mongoose.Schema({ 
      productId: mongoose.Schema.Types.ObjectId, 
      rating: Number, 
      status: String 
    }));
    
    const Product = mongoose.model('Product', new mongoose.Schema({ 
      ratings: { average: Number, count: Number } 
    }));

    const products = await Product.find({});
    console.log(`Processing ${products.length} products...`);

    for (const p of products) {
      const stats = await Review.aggregate([
        { $match: { productId: p._id, status: 'approved' } },
        { $group: { _id: null, avg: { $avg: '$rating' }, count: { $sum: 1 } } }
      ]);

      if (stats.length > 0) {
        await Product.findByIdAndUpdate(p._id, {
          'ratings.average': parseFloat(stats[0].avg.toFixed(1)),
          'ratings.count': stats[0].count
        });
        console.log(`Updated product ${p._id}: ${stats[0].count} reviews, ${stats[0].avg.toFixed(1)} avg`);
      } else {
        await Product.findByIdAndUpdate(p._id, {
          'ratings.average': 0,
          'ratings.count': 0
        });
        console.log(`Reset product ${p._id} to 0`);
      }
    }

    console.log('Done!');
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

resetRatings();
