import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { getPool } from './src/lib/db.js';
import { handler as homepageHandler } from './src/api/homepageApi.js';
import { handler as categoryHandler } from './src/api/categoryApi.js';

const app = express();
const PORT = process.env.PORT || 8080;
const pool = getPool();
const imgBase = process.env.CLOUDFRONT_IMG_BASE || '';

// Middleware
app.use(cors());
app.use(express.json());

// Helper function to transform product
function transformProduct(row) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    primary_image: row.primary_image
      ? `${imgBase}${row.primary_image}?w=420&q=70`
      : null,
    price: row.price ? parseFloat(row.price) : null,
    compare_at_price: row.compare_at_price
      ? parseFloat(row.compare_at_price)
      : null,
    discount_percentage: row.discount_percentage || 0,
    rating: row.rating ? parseFloat(row.rating) : null,
    review_count: row.review_count || 0,
    in_stock: row.stock > 0 && row.status === 'active',
    brand_name: row.brand_name || null,
    stock: row.stock || 0,
  };
}

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============================================
// HOMEPAGE API (Combined)
// ============================================
app.get('/v1/homepage', async (req, res) => {
  try {
    const event = {
      httpMethod: 'GET',
      path: '/v1/homepage',
      queryStringParameters: req.query,
    };
    const context = { requestId: req.id || `req-${Date.now()}` };
    
    const response = await homepageHandler(event, context);
    const body = JSON.parse(response.body);
    
    res.status(response.statusCode).json(body);
  } catch (error) {
    console.error('Homepage error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// BEST SELLING PRODUCTS API
// ============================================
app.get('/v1/products/best-selling', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || 12), 60);
    
    const result = await pool.query(
      `
      SELECT 
        p.id, p.slug, p.title, p.primary_image,
        p.price, p.compare_at_price, p.discount_percentage,
        p.rating, p.review_count, p.stock,
        p.brand_name, p.status
      FROM products p
      WHERE p.status = 'active' 
        AND p.deleted_at IS NULL
        AND p.price IS NOT NULL
      ORDER BY
        (p.stock > 0) DESC,
        p.rating DESC NULLS LAST,
        p.review_count DESC NULLS LAST,
        p.created_at DESC
      LIMIT $1
      `,
      [limit]
    );

    res.json({
      data: result.rows.map(transformProduct),
      meta: {
        total: result.rows.length,
        limit: limit,
      }
    });
  } catch (error) {
    console.error('Best selling error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// TOP DEALS API (Highest Discounts)
// ============================================
app.get('/v1/products/top-deals', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || 12), 60);
    
    const result = await pool.query(
      `
      SELECT 
        p.id, p.slug, p.title, p.primary_image,
        p.price, p.compare_at_price, p.discount_percentage,
        p.rating, p.review_count, p.stock,
        p.brand_name, p.status
      FROM products p
      WHERE p.status = 'active' 
        AND p.deleted_at IS NULL
        AND p.price IS NOT NULL
        AND p.compare_at_price IS NOT NULL
        AND p.compare_at_price > p.price
        AND p.discount_percentage > 0
      ORDER BY
        (p.stock > 0) DESC,
        p.discount_percentage DESC,
        p.review_count DESC NULLS LAST
      LIMIT $1
      `,
      [limit]
    );

    res.json({
      data: result.rows.map(transformProduct),
      meta: {
        total: result.rows.length,
        limit: limit,
      }
    });
  } catch (error) {
    console.error('Top deals error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// BEST RATED PRODUCTS API
// ============================================
app.get('/v1/products/best-rated', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || 12), 60);
    const minReviews = parseInt(req.query.min_reviews || 10);
    
    const result = await pool.query(
      `
      SELECT 
        p.id, p.slug, p.title, p.primary_image,
        p.price, p.compare_at_price, p.discount_percentage,
        p.rating, p.review_count, p.stock,
        p.brand_name, p.status
      FROM products p
      WHERE p.status = 'active' 
        AND p.deleted_at IS NULL
        AND p.price IS NOT NULL
        AND p.review_count >= $2
        AND p.rating IS NOT NULL
      ORDER BY
        (p.stock > 0) DESC,
        p.rating DESC,
        p.review_count DESC
      LIMIT $1
      `,
      [limit, minReviews]
    );

    res.json({
      data: result.rows.map(transformProduct),
      meta: {
        total: result.rows.length,
        limit: limit,
        min_reviews: minReviews,
      }
    });
  } catch (error) {
    console.error('Best rated error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// NEW ARRIVALS API
// ============================================
app.get('/v1/products/new-arrivals', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || 12), 60);
    
    const result = await pool.query(
      `
      SELECT 
        p.id, p.slug, p.title, p.primary_image,
        p.price, p.compare_at_price, p.discount_percentage,
        p.rating, p.review_count, p.stock,
        p.brand_name, p.status, p.created_at
      FROM products p
      WHERE p.status = 'active' 
        AND p.deleted_at IS NULL
        AND p.price IS NOT NULL
      ORDER BY
        p.created_at DESC,
        (p.stock > 0) DESC
      LIMIT $1
      `,
      [limit]
    );

    res.json({
      data: result.rows.map(transformProduct),
      meta: {
        total: result.rows.length,
        limit: limit,
      }
    });
  } catch (error) {
    console.error('New arrivals error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// TOP BRANDS API
// ============================================
app.get('/v1/brands', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || 12), 50);
    
    const result = await pool.query(
      `
      SELECT 
        TRIM(p.brand_name) AS name,
        COUNT(p.id) AS product_count,
        COALESCE(AVG(p.rating), 0) AS avg_rating,
        SUM(p.review_count) AS total_reviews
      FROM products p
      WHERE p.status = 'active' 
        AND p.deleted_at IS NULL
        AND p.price IS NOT NULL
        AND p.brand_name IS NOT NULL
        AND p.brand_name != ''
      GROUP BY TRIM(p.brand_name)
      HAVING COUNT(p.id) > 0
      ORDER BY COUNT(p.id) DESC, SUM(p.review_count) DESC
      LIMIT $1
      `,
      [limit]
    );

    const brands = result.rows.map(row => ({
      id: row.name.toUpperCase(),
      name: row.name,
      slug: row.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      product_count: parseInt(row.product_count, 10),
      avg_rating: parseFloat(row.avg_rating || 0).toFixed(2),
      total_reviews: parseInt(row.total_reviews || 0, 10),
    }));

    res.json({
      data: brands,
      meta: {
        total: brands.length,
        limit: limit,
      }
    });
  } catch (error) {
    console.error('Brands error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// PRODUCTS BY BRAND API
// ============================================
app.get('/v1/brands/:brandSlug/products', async (req, res) => {
  try {
    const brandSlug = req.params.brandSlug;
    const brandName = brandSlug.replace(/-/g, ' ');
    const page = Math.max(parseInt(req.query.page || 1), 1);
    const limit = Math.min(parseInt(req.query.limit || 24), 60);
    const offset = (page - 1) * limit;
    
    const result = await pool.query(
      `
      SELECT 
        p.id, p.slug, p.title, p.primary_image,
        p.price, p.compare_at_price, p.discount_percentage,
        p.rating, p.review_count, p.stock,
        p.brand_name, p.status
      FROM products p
      WHERE p.status = 'active' 
        AND p.deleted_at IS NULL
        AND p.price IS NOT NULL
        AND LOWER(p.brand_name) = LOWER($1)
      ORDER BY
        (p.stock > 0) DESC,
        p.rating DESC NULLS LAST,
        p.review_count DESC NULLS LAST
      LIMIT $2 OFFSET $3
      `,
      [brandName, limit, offset]
    );

    // Get total count
    const countResult = await pool.query(
      `SELECT COUNT(*) as total
       FROM products p
       WHERE p.status = 'active' 
         AND p.deleted_at IS NULL
         AND p.price IS NOT NULL
         AND LOWER(p.brand_name) = LOWER($1)`,
      [brandName]
    );

    res.json({
      data: result.rows.map(transformProduct),
      meta: {
        page: page,
        limit: limit,
        total: parseInt(countResult.rows[0].total, 10),
      }
    });
  } catch (error) {
    console.error('Brand products error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// CATEGORIES API
// ============================================
app.get('/v1/categories', async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT 
        c.id, c.name, c.slug, c.image_url, c.description,
        c.parent_id, c.level,
        (
          SELECT COUNT(*)
          FROM products p
          WHERE p.category_id = c.id
            AND p.status = 'active'
            AND p.deleted_at IS NULL
            AND p.price IS NOT NULL
        ) AS product_count
      FROM categories c
      WHERE c.is_active = true 
        AND EXISTS (
          SELECT 1 FROM products p
          WHERE p.category_id = c.id
            AND p.status = 'active'
            AND p.deleted_at IS NULL
            AND p.price IS NOT NULL
        )
      ORDER BY c.level ASC, c.display_order ASC, c.name ASC
      `
    );

    const categories = result.rows.map(row => ({
      id: row.id,
      name: row.name,
      slug: row.slug,
      image_url: row.image_url ? `${imgBase}${row.image_url}` : null,
      description: row.description,
      parent_id: row.parent_id,
      level: row.level,
      product_count: parseInt(row.product_count, 10),
    }));

    res.json({
      data: categories,
      meta: {
        total: categories.length,
      }
    });
  } catch (error) {
    console.error('Categories error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// CATEGORY API (With Subcategories and Products)
// ============================================
app.get('/v1/category/:slug', async (req, res) => {
  try {
    const event = {
      httpMethod: 'GET',
      path: `/v1/category/${req.params.slug}`,
      pathParameters: { slug: req.params.slug },
      queryStringParameters: req.query,
    };
    const context = { requestId: req.id || `req-${Date.now()}` };
    
    const response = await categoryHandler(event, context);
    const body = JSON.parse(response.body);
    
    res.status(response.statusCode).json(body);
  } catch (error) {
    console.error('Category error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ============================================
// FEATURED PRODUCTS API (High rating + good discount)
// ============================================
app.get('/v1/products/featured', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || 12), 60);
    
    const result = await pool.query(
      `
      SELECT 
        p.id, p.slug, p.title, p.primary_image,
        p.price, p.compare_at_price, p.discount_percentage,
        p.rating, p.review_count, p.stock,
        p.brand_name, p.status
      FROM products p
      WHERE p.status = 'active' 
        AND p.deleted_at IS NULL
        AND p.price IS NOT NULL
        AND p.rating >= 4.0
        AND p.discount_percentage >= 10
      ORDER BY
        (p.stock > 0) DESC,
        (p.rating * p.review_count) DESC,
        p.discount_percentage DESC
      LIMIT $1
      `,
      [limit]
    );

    res.json({
      data: result.rows.map(transformProduct),
      meta: {
        total: result.rows.length,
        limit: limit,
      }
    });
  } catch (error) {
    console.error('Featured products error:', error);
    res.status(500).json({ error: error.message });
  }
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Route ${req.method} ${req.path} not found`,
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
  console.log(`\n📝 Available Endpoints:`);
  console.log(`   GET /health`);
  console.log(`   GET /v1/homepage`);
  console.log(`   GET /v1/products/best-selling?limit=12`);
  console.log(`   GET /v1/products/top-deals?limit=12`);
  console.log(`   GET /v1/products/best-rated?limit=12&min_reviews=10`);
  console.log(`   GET /v1/products/new-arrivals?limit=12`);
  console.log(`   GET /v1/products/featured?limit=12`);
  console.log(`   GET /v1/brands?limit=12`);
  console.log(`   GET /v1/brands/:brandSlug/products?page=1&limit=24`);
  console.log(`   GET /v1/categories`);
  console.log(`   GET /v1/category/:slug?page=1&limit=24`);
});
