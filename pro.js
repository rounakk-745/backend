/**
 * GET /category/:slug
 * Category page API - shows products in a category and its subcategories
 * Supports pagination, car compatibility, and optional Redis caching
 * 
 * ES Module for Node.js 20 Lambda
 */

import { getPool } from '../../lib/db.js';

// ===== Configuration =====
const REDIS_ENABLED = process.env.REDIS_ENABLED === 'true';
const CACHE_TTL_SECONDS = parseInt(process.env.CACHE_TTL_SECONDS || '300', 10);
const CLOUDFRONT_IMG_BASE = process.env.CLOUDFRONT_IMG_BASE || '';

// ===== Database Connection Pool =====
// Using shared pool from db.js for consistency

// ===== Redis Client (lazy initialization) =====
let redisClient = null;
let redisConnectionAttempted = false;
let redisConnectionFailed = false;

async function getRedisClient() {
  if (!REDIS_ENABLED || redisConnectionFailed) {
    return null;
  }

  if (!redisClient && !redisConnectionAttempted) {
    redisConnectionAttempted = true;
    try {
      // Dynamic import for optional Redis dependency
      const { default: Redis } = await import('ioredis');
      redisClient = new Redis({
        host: process.env.REDIS_HOST,
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
        password: process.env.REDIS_PASS,
        connectTimeout: 3000,
        maxRetriesPerRequest: 1,
        lazyConnect: true,
        retryStrategy: () => null, // Don't retry, fail fast
      });

      await redisClient.connect();
      
      // Test connection
      await redisClient.ping();
    } catch (error) {
      console.error(JSON.stringify({
        level: 'WARN',
        message: 'Redis connection failed, caching disabled for this Lambda instance',
        error: error.message,
        timestamp: new Date().toISOString(),
      }));
      redisConnectionFailed = true;
      if (redisClient) {
        redisClient.disconnect();
      }
      redisClient = null;
    }
  }
  return redisClient;
}

// ===== Redis Operations with Timeout =====
async function redisGetWithTimeout(redis, key, timeoutMs = 1000) {
  return Promise.race([
    redis.get(key),
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Redis operation timeout')), timeoutMs)
    ),
  ]);
}

async function redisSetWithTimeout(redis, key, value, ttl, timeoutMs = 1000) {
  return Promise.race([
    redis.setex(key, ttl, value),
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error('Redis operation timeout')), timeoutMs)
    ),
  ]);
}

// ===== Logging Utility =====
function log(level, message, context, requestId) {
  console.log(JSON.stringify({
    level,
    message,
    timestamp: new Date().toISOString(),
    ...(requestId && { requestId }),
    ...(context && { context }),
  }));
}

// ===== Cache Key Generation =====
function generateCacheKey(slug, page, limit, carId) {
  const carPart = carId ? `:car=${carId}` : '';
  return `category:v1:${slug}:p${page}:l${limit}${carPart}`;
}

// ===== Response Helpers =====
function createResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Credentials': true,
    },
    body: JSON.stringify(body),
  };
}

function okResponse(data, meta) {
  return createResponse(200, { data, meta });
}

function badRequestResponse(message, details) {
  return createResponse(400, {
    error: 'Bad Request',
    message,
    ...(details && { details }),
  });
}

function notFoundResponse(message) {
  return createResponse(404, {
    error: 'Not Found',
    message,
  });
}

function serverErrorResponse(message, requestId) {
  return createResponse(500, {
    error: 'Internal Server Error',
    message,
    ...(requestId && { requestId }),
  });
}

// ===== Validation =====
function validateParams(slug, page, limit, carId) {
  const errors = [];

  if (!slug || typeof slug !== 'string' || slug.trim().length === 0) {
    errors.push('Category slug is required');
  }

  if (isNaN(page) || page < 1) {
    errors.push('Page must be a positive integer');
  }

  if (isNaN(limit) || limit < 1 || limit > 60) {
    errors.push('Limit must be between 1 and 60');
  }

  if (carId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(carId)) {
    errors.push('car_id must be a valid UUID');
  }

  return errors;
}

// ===== Database Queries =====
async function getCategoryIdAndDescendants(client, slug) {
  // Sanitize slug for security
  const sanitizedSlug = String(slug).trim().toLowerCase();
  
  // Get category ID and all its descendant IDs (including itself)
  const query = `
    WITH RECURSIVE category_tree AS (
      -- Base case: find the requested category
      SELECT id, parent_id, slug, name, level
      FROM categories
      WHERE slug = $1 AND is_active = true
      
      UNION ALL
      
      -- Recursive case: find all children (max depth 5 for safety)
      SELECT c.id, c.parent_id, c.slug, c.name, c.level
      FROM categories c
      INNER JOIN category_tree ct ON c.parent_id = ct.id
      WHERE c.is_active = true AND c.level < 5
    )
    SELECT id FROM category_tree;
  `;

  const result = await client.query(query, [sanitizedSlug]);
  
  if (result.rows.length === 0) {
    return null;
  }

  const categoryIds = result.rows.map(row => row.id);
  
  // Validate all IDs are proper UUIDs (defense in depth)
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const validIds = categoryIds.filter(id => uuidRegex.test(id));
  
  if (validIds.length === 0) {
    return null;
  }
  
  return validIds;
}

async function getProductsForCategories(client, categoryIds, page, limit, carId) {
  const offset = (page - 1) * limit;

  // Build the main query with compatibility check if carId provided
  const compatibilitySelect = carId ? `
    , CASE
        WHEN pc.car_id IS NOT NULL THEN 'specific'
        WHEN p.is_universal = true THEN 'universal'
        ELSE 'unknown'
      END AS compatibility
  ` : ', NULL AS compatibility';

  const compatibilityJoin = carId ? `
    LEFT JOIN product_cars pc ON pc.product_id = p.id AND pc.car_id = $4
  ` : '';

  // Get products with sorting: out-of-stock last, then by rating, sales_count, created_at
  // Note: Unique constraint on product_cars(product_id, car_id) prevents duplicates
  const productsQuery = `
    SELECT 
      p.id,
      p.slug,
      p.title,
      p.primary_image,
      p.price,
      p.compare_at_price,
      p.discount_percentage,
      p.rating,
      p.review_count,
      p.stock,
      p.status,
      p.is_universal,
      p.brand_name,
      p.created_at
      ${compatibilitySelect}
    FROM products p
    ${compatibilityJoin}
    WHERE p.category_id = ANY($1::uuid[])
      AND p.status = 'active'
      AND p.deleted_at IS NULL
      AND p.price IS NOT NULL
    ORDER BY
      (p.stock > 0) DESC,
      p.rating DESC NULLS LAST,
      p.sales_count DESC NULLS LAST,
      p.created_at DESC
    LIMIT $2 OFFSET $3
  `;

  const productsParams = carId 
    ? [categoryIds, limit, offset, carId]
    : [categoryIds, limit, offset];

  const productsResult = await client.query(productsQuery, productsParams);
  const products = productsResult.rows;

  // Conditionally run COUNT query only if needed
  let total;
  if (page === 1 && products.length < limit) {
    // We have all results on first page, no need for expensive COUNT
    total = products.length;
  } else {
    // Need full count for pagination
    const countQuery = `
      SELECT COUNT(*) as total
      FROM products p
      WHERE p.category_id = ANY($1::uuid[])
        AND p.status = 'active'
        AND p.deleted_at IS NULL
        AND p.price IS NOT NULL
    `;
    const countResult = await client.query(countQuery, [categoryIds]);
    total = parseInt(countResult.rows[0].total, 10);
  }

  return {
    total,
    products,
  };
}

// ===== Brand Slug Cache (performance optimization) =====
const brandSlugCache = new Map();
// Limit cache size to prevent memory issues
const MAX_BRAND_CACHE_SIZE = 1000;

function getBrandSlug(brandName) {
  if (!brandSlugCache.has(brandName)) {
    const slug = brandName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    
    // Simple LRU: clear cache if too large
    if (brandSlugCache.size >= MAX_BRAND_CACHE_SIZE) {
      brandSlugCache.clear();
    }
    
    brandSlugCache.set(brandName, slug);
  }
  return brandSlugCache.get(brandName);
}

// ===== Product Transformation =====
function transformProduct(row) {
  const inStock = row.stock > 0 && row.status === 'active';
  const badges = [];

  if (!inStock) {
    badges.push('Out of stock');
  }

  // Compute discount percentage if compare_at_price exists
  let discountPercentage = row.discount_percentage || 0;
  if (row.compare_at_price && row.price && row.compare_at_price > row.price) {
    discountPercentage = Math.round(
      ((row.compare_at_price - row.price) / row.compare_at_price) * 100
    );
  }

  // Generate brand object (with cached slug generation)
  const brand = row.brand_name ? {
    id: row.brand_name.toUpperCase(),
    name: row.brand_name,
    slug: getBrandSlug(row.brand_name),
  } : null;

  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    primary_image: row.primary_image 
      ? `${CLOUDFRONT_IMG_BASE}${row.primary_image}?w=420&q=70`
      : null,
    price: row.price ? parseFloat(row.price) : null,
    compare_at_price: row.compare_at_price ? parseFloat(row.compare_at_price) : null,
    discount_percentage: discountPercentage,
    rating: row.rating ? parseFloat(row.rating) : null,
    review_count: row.review_count || 0,
    in_stock: inStock,
    badges,
    compatibility: row.compatibility || 'unknown',
    brand,
  };
}

// ===== Main Handler =====
/**
 * Lambda handler for GET /v1/category/:slug
 * @param {import('aws-lambda').APIGatewayProxyEvent} event
 * @param {import('aws-lambda').Context} context
 * @returns {Promise<import('aws-lambda').APIGatewayProxyResult>}
 */
export async function handler(event, context) {
  const requestId = context.requestId || context.awsRequestId;
  const startTime = Date.now();

  try {
    // Extract parameters with validation
    const slug = event.pathParameters?.slug;
    const queryParams = event.queryStringParameters || {};
    const rawPage = parseInt(queryParams.page || '1', 10);
    const rawLimit = parseInt(queryParams.limit || '24', 10);
    const page = isNaN(rawPage) ? 1 : Math.max(1, rawPage);
    const limit = Math.min(isNaN(rawLimit) ? 24 : Math.max(1, rawLimit), 60);
    const carId = queryParams.car_id || null;

    log('INFO', 'Category page request', {
      slug,
      page,
      limit,
      carId,
    }, requestId);

    // Validate parameters
    const validationErrors = validateParams(slug, page, limit, carId);
    if (validationErrors.length > 0) {
      return badRequestResponse('Invalid parameters', validationErrors);
    }

    // Generate cache key
    const cacheKey = generateCacheKey(slug, page, limit, carId);
    let cacheHit = false;

    // Try cache if enabled
    if (REDIS_ENABLED) {
      try {
        const redis = await getRedisClient();
        if (redis) {
          const cached = await redisGetWithTimeout(redis, cacheKey, 1000);
          if (cached) {
            cacheHit = true;
            const latencyMs = Date.now() - startTime;
            
            log('INFO', 'Category page cache hit', {
              slug,
              page,
              limit,
              carId,
              cacheHit: true,
              latencyMs,
            }, requestId);

            const cachedData = JSON.parse(cached);
            return okResponse(cachedData.data, cachedData.meta);
          }
        }
      } catch (cacheError) {
        log('WARN', 'Cache read error', {
          error: cacheError.message,
          timeout: cacheError.message.includes('timeout'),
        }, requestId);
        // Continue without cache
      }
    }

    // Get database connection
    const pool = getPool();
    const client = await pool.connect();

    try {
      // Get category and its descendants
      const categoryIds = await getCategoryIdAndDescendants(client, slug);

      if (!categoryIds || categoryIds.length === 0) {
        return notFoundResponse(`Category '${slug}' not found`);
      }

      // Get products
      const { total, products } = await getProductsForCategories(
        client,
        categoryIds,
        page,
        limit,
        carId
      );

      // Transform products
      const transformedProducts = products.map(transformProduct);

      // Build response
      const responseData = {
        data: transformedProducts,
        meta: {
          page,
          limit,
          total,
        },
      };

      // Cache result if enabled
      if (REDIS_ENABLED && !cacheHit) {
        try {
          const redis = await getRedisClient();
          if (redis) {
            await redisSetWithTimeout(
              redis,
              cacheKey,
              JSON.stringify(responseData),
              CACHE_TTL_SECONDS,
              1000
            );
          }
        } catch (cacheError) {
          log('WARN', 'Cache write error', {
            error: cacheError.message,
            timeout: cacheError.message.includes('timeout'),
          }, requestId);
          // Continue without caching
        }
      }

      const latencyMs = Date.now() - startTime;

      // Log slow queries for monitoring
      if (latencyMs > 500) {
        log('WARN', 'Slow category query detected', {
          slug,
          page,
          limit,
          carId,
          categoryCount: categoryIds.length,
          resultCount: transformedProducts.length,
          latencyMs,
          slowQueryAlert: true,
        }, requestId);
      }

      log('INFO', 'Category page request completed', {
        slug,
        page,
        limit,
        carId,
        cacheHit,
        resultCount: transformedProducts.length,
        latencyMs,
      }, requestId);

      return okResponse(responseData.data, responseData.meta);

    } finally {
      client.release();
    }

  } catch (error) {
    const latencyMs = Date.now() - startTime;

    log('ERROR', 'Category page request failed', {
      error: error.message,
      stack: error.stack,
      latencyMs,
    }, requestId);

    return serverErrorResponse('Internal server error', requestId);
  }
}

// ===== Cleanup (for tests) =====
export async function closeConnections() {
  // Note: Pool is managed by db.js, no need to close here
  if (redisClient) {
    try {
      await redisClient.quit();
    } catch (err) {
      // Ignore cleanup errors
    }
    redisClient = null;
  }
  // Reset connection flags and cache
  redisConnectionAttempted = false;
  redisConnectionFailed = false;
  brandSlugCache.clear();
}