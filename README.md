1. Homepage API
Endpoint: **GET /v1/homepage**

Description: Combined API returning all homepage sections

Returns: Best selling, categories, brands, top deals, best rated

Query Params: None

---

2. Best Selling Products API
Endpoint: **GET /v1/products/best-selling**

Description: Top products sorted by rating and reviews

Query Params:

limit (default: 12, max: 60)

---

3. Top Deals API
Endpoint: **GET /v1/products/top-deals**

Description: Products with highest discounts

Query Params:

limit (default: 12, max: 60)

---

4. Best Rated Products API
Endpoint: **GET /v1/products/best-rated**

Description: Highest rated products with minimum reviews

Query Params:

limit (default: 12, max: 60)

min_reviews (default: 10)

---

5. New Arrivals API
Endpoint: **GET /v1/products/new-arrivals**

Description: Recently added products

Query Params:

limit (default: 12, max: 60)

---

6. Featured Products API
Endpoint: **GET /v1/products/featured**

Description: Products with high rating (≥4.0) and good discount (≥10%)

Query Params:

limit (default: 12, max: 60)

---

7. Categories List API
Endpoint: **GET /v1/categories**

Description: All active categories with product counts

Query Params: None

Returns: Category hierarchy with product counts

---

8. Category Products API (with filtering)
Endpoint: **GET /v1/category/:slug**

Description: Products in a specific category with pagination

URL Params:

slug (category slug, e.g., "brake-pads")

Query Params:

page (default: 1)

limit (default: 24, max: 60)

car_id (optional UUID for car compatibility filtering)

Features:

- Pagination

- Car compatibility filtering

- Redis caching (5 min TTL)

- Recursive category tree (includes subcategories)

---

9. All Brands API
Endpoint: GET /v1/brands

Description: List of all brands with statistics

Query Params:

limit (default: 12, max: 50)

Returns: Brand name, product count, avg rating, total reviews

---

10. Products by Brand API
Endpoint: **GET /v1/brands/:brandSlug/products**

Description: All products from a specific brand

URL Params:

brandSlug (e.g., "brembo")

Query Params:

page (default: 1)

limit (default: 24, max: 60)