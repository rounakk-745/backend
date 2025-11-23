const [
      bestSellingRows,
      categoriesRows,
      brandsRows,
      dealsRows,
      bestRatedRows,
    ] = await Promise.all([
      // 1. Best Selling Products
      pool.query(
        `
        SELECT 
          p.id, p.slug, p.title, p.primary_image,
          p.price, p.compare_at_price, p.discount_percentage,
          p.rating, p.review_count, p.stock,
          p.brand_name
        FROM products p
        WHERE p.status = 'active' 
          AND p.deleted_at IS NULL
          AND p.price IS NOT NULL
        ORDER BY
          (p.stock > 0) DESC,
          p.sales_count DESC NULLS LAST,
          p.rating DESC NULLS LAST,
          p.created_at DESC
        LIMIT $1
        `,
        [limitProducts]
      ).then((res) => res.rows).catch((err) => {
        logger.warn('Best selling query failed', { error: err.message });
        return [];
      }),

      // 2. Shop By Categories (top-level only, with product counts)
      pool.query(
        `
        SELECT 
          c.id, c.name, c.slug, c.image_url,
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
          AND c.parent_id IS NULL
          AND EXISTS (
            SELECT 1 FROM products p
            WHERE p.category_id = c.id
              AND p.status = 'active'
              AND p.deleted_at IS NULL
              AND p.price IS NOT NULL
          )
        ORDER BY c.display_order ASC, c.name ASC
        LIMIT $1
        `,
        [limitCategories]
      ).then((res) => res.rows).catch((err) => {
        logger.warn('Categories query failed', { error: err.message });
        return [];
      }),

      // 3. Top Brands (by brand name from products)
      pool.query(
        `
        SELECT 
          TRIM(p.brand_name) AS name,
          COUNT(p.id) AS product_count,
          SUM(p.sales_count) AS total_sales
        FROM products p
        WHERE p.status = 'active' 
          AND p.deleted_at IS NULL
          AND p.price IS NOT NULL
          AND p.brand_name IS NOT NULL
          AND p.brand_name != ''
        GROUP BY TRIM(p.brand_name)
        HAVING SUM(p.sales_count) > 0
        ORDER BY SUM(p.sales_count) DESC
        LIMIT 12
        `
      ).then((res) => res.rows).catch((err) => {
        logger.warn('Brands query failed', { error: err.message });
        return [];
      }),

      // 4. Top Deals (highest discounts)
      pool.query(
        `
        SELECT 
          p.id, p.slug, p.title, p.primary_image,
          p.price, p.compare_at_price, p.discount_percentage,
          p.rating, p.review_count, p.stock,
          p.brand_name
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
          p.sales_count DESC NULLS LAST
        LIMIT $1
        `,
        [limitProducts]
      ).then((res) => res.rows).catch((err) => {
        logger.warn('Top deals query failed', { error: err.message });
        return [];
      }),

      // 5. Best Rated Products (minimum 10 reviews)
      pool.query(
        `
        SELECT 
          p.id, p.slug, p.title, p.primary_image,
          p.price, p.compare_at_price, p.discount_percentage,
          p.rating, p.review_count, p.stock,
          p.brand_name
        FROM products p
        WHERE p.status = 'active' 
          AND p.deleted_at IS NULL
          AND p.price IS NOT NULL
          AND p.review_count >= 10
          AND p.rating IS NOT NULL
        ORDER BY
          (p.stock > 0) DESC,
          p.rating DESC,
          p.review_count DESC,
          p.sales_count DESC NULLS LAST
        LIMIT $1
        `,
        [limitProducts]
      ).then((res) => res.rows).catch((err) => {
        logger.warn('Best rated query failed', { error: err.message });
        return [];
      }),
    ]);

    const queryDuration = Date.now() - queryStart;

    // Transform product rows
    const transformProduct = (row) => ({
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
      in_stock: row.stock > 0,
      brand_name: row.brand_name || null,
    });

    // Build response
    const response = {
      data: {
        best_selling: bestSellingRows.map(transformProduct),
        shop_by_categories: categoriesRows.map((row) => ({
          id: row.id,
          name: row.name,
          slug: row.slug,
          image_url: row.image_url ? `${imgBase}${row.image_url}` : null,
          product_count: parseInt(row.product_count, 10),
        })),
        top_brands: brandsRows.map((row) => {
          const name = row.name || '';
          return {
            id: name.toUpperCase(),
            name: name,
            slug: getBrandSlug(name),
            product_count: parseInt(row.product_count, 10),
            total_sales: parseInt(row.total_sales, 10),
          };
        }),
        top_deals: dealsRows.map(transformProduct),
        best_rated: bestRatedRows.map(transformProduct),
      },
      meta: {
        limits: {
          products: limitProducts,
          categories: limitCategories,
        },
        generated_at: new Date().toISOString(),
      },
    };

    logger.info('Homepage query completed', {
      latency_ms: queryDuration,
      best_selling: bestSellingRows.length,
      categories: categoriesRows.length,
      brands: brandsRows.length,
      top_deals: dealsRows.length,
      best_rated: bestRatedRows.length,
      requestId,
    });

    logger.logRequest(event.httpMethod, event.path, 200, {
      latency_ms: queryDuration,
    });

    return ok(response.data, response.meta);
  } catch (error) {
    logger.error('Homepage request failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
      requestId,
    });

    return serverError('internal_error', requestId);
  } finally {
    logger.clearContext();
  }
}