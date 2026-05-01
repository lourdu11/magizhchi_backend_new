const mongoose = require('mongoose');
const Review = require('../models/Review');
const Product = require('../models/Product');
const Order = require('../models/Order');
const ApiResponse = require('../utils/apiResponse');

// Create review (User)
exports.createReview = async (req, res, next) => {
  try {
    const { productId, rating, comment, title, images } = req.body;
    
    // Check if user has purchased the product
    const order = await Order.findOne({
      userId: req.user._id,
      'items.productId': productId,
      orderStatus: 'delivered'
    });

    const isVerifiedPurchase = !!order;

    // ATOMIC UPSERT: Find and Update or Create in one unbreakable step
    const review = await Review.findOneAndUpdate(
      { productId, userId: req.user._id },
      {
        rating,
        comment,
        title: title || (rating >= 4 ? 'Excellent' : rating >= 3 ? 'Good' : 'Average'),
        images: images || [],
        isVerifiedPurchase,
        status: 'pending' // Always revert to pending for review
      },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true }
    );

    // TRIGGER RECALCULATION: Refresh product stats
    const stats = await Review.aggregate([
      { $match: { productId: new mongoose.Types.ObjectId(productId), status: 'approved' } },
      { $group: { _id: '$productId', avgRating: { $avg: '$rating' }, count: { $sum: 1 } } }
    ]);
    
    await Product.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(productId) },
      { 
        $set: { 
          'ratings.average': stats.length > 0 ? parseFloat(stats[0].avgRating.toFixed(1)) : 0,
          'ratings.count': stats.length > 0 ? stats[0].count : 0 
        } 
      }
    );

    return ApiResponse.success(res, review, 'Review saved and pending approval');
  } catch (error) { next(error); }
};

// Get product reviews (Public)
exports.getProductReviews = async (req, res, next) => {
  try {
    const { sort = '-createdAt' } = req.query;
    const reviews = await Review.find({ 
      productId: req.params.productId,
      status: 'approved'
    }).populate('userId', 'name').sort(sort);
    
    return ApiResponse.success(res, reviews);
  } catch (error) { next(error); }
};

// Admin: Get all reviews
exports.getAllReviews = async (req, res, next) => {
  try {
    const reviews = await Review.find()
      .populate('productId', 'name images')
      .populate('userId', 'name email')
      .sort('-createdAt');
    return ApiResponse.success(res, reviews);
  } catch (error) { next(error); }
};

// Admin: Update review status
exports.updateReviewStatus = async (req, res, next) => {
  try {
    const { status, adminReply } = req.body;
    const reviewId = req.params.id;
    
    // 1. Fetch review manually using findById (non-modifying)
    const review = await Review.findById(reviewId);
    if (!review) return ApiResponse.notFound(res, 'Review not found');
    
    const update = { $set: { status } };
    if (adminReply) {
      update.$set.adminReply = {
        message: adminReply,
        repliedAt: new Date()
      };
    }
    
    // ATOMIC OPTION: Use raw collection to bypass ALL validation/hooks
    await Review.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(reviewId) },
      update
    );

    // If approved, update product average rating
    if (status === 'approved') {
      const stats = await Review.aggregate([
        { $match: { productId: review.productId, status: 'approved' } },
        { $group: { _id: '$productId', avgRating: { $avg: '$rating' }, count: { $sum: 1 } } }
      ]);
      
      if (stats.length > 0) {
        // Use raw collection for product as well to be 100% safe
        await Product.collection.updateOne(
          { _id: review.productId },
          { 
            $set: { 
              'ratings.average': parseFloat(stats[0].avgRating.toFixed(1)),
              'ratings.count': stats[0].count 
            } 
          }
        );
      }
    }

    return ApiResponse.success(res, null, `Review ${status} successfully`);
  } catch (error) { 
    next(error); 
  }
};

// Get Review Stats (Public)
exports.getReviewStats = async (req, res, next) => {
  try {
    const { productId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(productId)) {
       return ApiResponse.success(res, { totalReviews: 0, breakdown: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, averageRating: 0 });
    }

    const stats = await Review.aggregate([
      { $match: { productId: new mongoose.Types.ObjectId(productId), status: 'approved' } },
      {
        $group: {
          _id: '$rating',
          count: { $sum: 1 }
        }
      }
    ]);

    const totalReviews = stats.reduce((acc, curr) => acc + curr.count, 0);
    const breakdown = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    stats.forEach(s => breakdown[s._id] = s.count);

    return ApiResponse.success(res, {
      totalReviews,
      breakdown,
      averageRating: totalReviews > 0 ? (stats.reduce((acc, curr) => acc + (curr._id * curr.count), 0) / totalReviews).toFixed(1) : 0
    });
  } catch (error) { next(error); }
};

// Like a review
exports.likeReview = async (req, res, next) => {
  try {
    const review = await Review.findById(req.params.id);
    if (!review) return ApiResponse.notFound(res, 'Review not found');

    const userId = req.user._id;
    const hasLiked = review.likedBy.some(id => id.toString() === userId.toString());
    const hasDisliked = review.dislikedBy.some(id => id.toString() === userId.toString());

    let update = {};
    if (hasLiked) {
      update = { $inc: { likes: -1 }, $pull: { likedBy: userId } };
    } else {
      update = { $inc: { likes: 1 }, $push: { likedBy: userId } };
      if (hasDisliked) {
        update.$inc.dislikes = -1;
        update.$pull = { dislikedBy: userId };
      }
    }

    const updatedReview = await Review.findByIdAndUpdate(req.params.id, update, { new: true });
    return ApiResponse.success(res, updatedReview, hasLiked ? 'Like removed' : 'Liked successfully');
  } catch (error) { next(error); }
};

// Dislike a review
exports.dislikeReview = async (req, res, next) => {
  try {
    const review = await Review.findById(req.params.id);
    if (!review) return ApiResponse.notFound(res, 'Review not found');

    const userId = req.user._id;
    const hasLiked = review.likedBy.some(id => id.toString() === userId.toString());
    const hasDisliked = review.dislikedBy.some(id => id.toString() === userId.toString());

    let update = {};
    if (hasDisliked) {
      update = { $inc: { dislikes: -1 }, $pull: { dislikedBy: userId } };
    } else {
      update = { $inc: { dislikes: 1 }, $push: { dislikedBy: userId } };
      if (hasLiked) {
        update.$inc.likes = -1;
        update.$pull = { likedBy: userId };
      }
    }

    const updatedReview = await Review.findByIdAndUpdate(req.params.id, update, { new: true });
    return ApiResponse.success(res, updatedReview, hasDisliked ? 'Dislike removed' : 'Disliked successfully');
  } catch (error) { next(error); }
};

// Admin: Delete a review
exports.deleteReview = async (req, res, next) => {
  try {
    const review = await Review.findById(req.params.id);
    if (!review) return ApiResponse.notFound(res, 'Review not found');

    const productId = review.productId;
    await Review.findByIdAndDelete(req.params.id);

    // RECALCULATE PRODUCT STATS
    const stats = await Review.aggregate([
      { $match: { productId, status: 'approved' } },
      { $group: { _id: '$productId', avgRating: { $avg: '$rating' }, count: { $sum: 1 } } }
    ]);
    
    if (stats.length > 0) {
      await Product.findByIdAndUpdate(productId, {
        'ratings.average': stats[0].avgRating.toFixed(1),
        'ratings.count': stats[0].count
      });
    } else {
      await Product.findByIdAndUpdate(productId, {
        'ratings.average': 0,
        'ratings.count': 0
      });
    }

    return ApiResponse.success(res, null, 'Review deleted successfully');
  } catch (error) { next(error); }
};
