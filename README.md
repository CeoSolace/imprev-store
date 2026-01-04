Imprev Store (Imprev Clothing)
Overview

Imprev‑Store (also named Imprev Clothing) is a full‑stack clothing store built with Node.js, Express, MongoDB and EJS. It serves a product catalogue to customers, handles secure checkouts via Stripe, uploads product images to Cloudinary, and automatically fulfils orders through the Printful API. An admin dashboard lets staff manage products, variants, discount codes, Stripe fee settings and view orders. The project is deployed using a render.yaml manifest and can be run locally or on Render.

High‑level architecture

Server entry point – server.js bootstraps the Express app, applies security middlewares (helmet, rate limiting, origin guard), sets the EJS view engine, registers routes and connects to MongoDB via src/db.js. It also ensures a default admin account and settings document exist.

Database – MongoDB is used to persist admins, products, variants, orders, discount codes and fee settings. Mongoose schemas live in src/models/.

Public facing routes – defined in src/routes/public.js and rendered via EJS templates in views/. These pages list products (/), show product details (/p/:id), handle checkout requests (/checkout), and display success/cancellation messages.

Admin routes – defined in src/routes/admin.js and protected by JWT cookies through src/middleware/adminOnly.js. Admin pages allow creation/editing of products and variants, toggling product availability, uploading images, managing discount/reference codes, viewing recent orders, and editing Stripe fee settings.

Webhooks – src/routes/webhooks.js listens for Stripe checkout completion events. On payment success it creates an order record, marks referral codes as used and calls Printful to fulfil the order. Order status is updated to fulfilled or failed depending on Printful’s response.

Configuration helpers – src/config/stripe.js wraps the Stripe SDK; src/config/cloudinary.js handles image uploads; src/config/printful.js posts orders to Printful; src/config/money.js contains helpers for calculating retail prices and Stripe fees; src/middleware/jwt.js signs/verifies JWTs for admin sessions; src/middleware/rawBody.js exposes raw JSON bodies for webhook signature verification.

Static assets – CSS, images and client‑side scripts live under public/ and are served via express.static().

Views – EJS templates in views/ render the storefront, product pages, checkout success/cancel pages, and the entire admin UI. They consume data passed from the controllers and use CSS variables defined in public/style.css to style the site.

Core features

Secure storefront – customers can browse products, view details and check out securely. Helmet, HSTS, origin checks and rate limiting minimise attack surface. HTTP → HTTPS redirection is enabled in production.

Product catalog with variants – each product can have multiple variants defined by SKU, name, size list, Printful variant ID, cost and region‑specific profit/shipping values. Variants are stored inside the variants array of a Product document (src/models/Product.js).

Price calculation – src/config/money.js computes a retail price in minor units that covers manufacturing, shipping, Stripe fees and a desired profit. It rounds up to avoid under‑charging and validates size/quantity ranges.

Stripe checkout – the /checkout route creates a Stripe checkout session using the selected variant, size, quantity and country. On success, users are redirected to /success; cancellations redirect to /cancel. Metadata attached to the session is used later to create an order record.

Discount and referral codes – codes are stored in src/models/Code.js as either reference (no discount) or referral (percentage discount with optional max uses). The checkout route validates codes and adjusts profit before creating the Stripe session. Admins can create, enable/disable and delete codes via the dashboard.

Admin authentication – admins log in with an email/password stored in the Admin collection. Passwords are hashed with bcrypt. Successful login issues a signed JWT (see src/middleware/jwt.js) saved in a cookie; all admin routes check this token via adminOnly middleware.

Image upload – the admin panel allows uploading up to six images per product. Uploaded files are sent to Cloudinary using uploadImageBuffer() and the returned secure URLs are saved in the product document.

Order processing and fulfilment – when Stripe confirms a payment, a webhook handler records an Order document with customer details, items purchased and totals. It then calls Printful’s API to create a print‑on‑demand order; the order status is updated to fulfilled on success or failed on error. Referral codes are marked as used through a MongoDB update.

Directory structure (key files)
imprev-store/
├─ server.js              # Express server entry; registers middleware/routes, connects DB
├─ package.json           # NPM package metadata and start script
├─ render.yaml            # Render deployment spec
├─ src/
│  ├─ db.js              # MongoDB connection and initial seeding (admin/settings)
│  ├─ models/
│  │  ├─ Admin.js        # Admin schema and ensureAdmin helper
│  │  ├─ Product.js      # Product schema with nested Variant subdoc
│  │  ├─ Code.js         # Discount/referral code schema
│  │  ├─ Settings.js     # Stripe fee settings schema and ensureSettings helper
│  │  └─ Order.js        # Order schema for completed/fulfilled/failed orders
│  ├─ routes/
│  │  ├─ public.js       # Customer‑facing routes (home, product page, checkout)
│  │  ├─ admin.js        # Admin dashboard routes (login, products, codes, settings, orders)
│  │  └─ webhooks.js     # Stripe webhook for order creation and Printful fulfilment
│  ├─ middleware/
│  │  ├─ jwt.js          # Sign/verify JWTs for admin sessions
│  │  ├─ adminOnly.js    # Protects admin routes by validating JWT cookies
│  │  └─ rawBody.js      # Exposes raw JSON bodies (used by Stripe webhooks)
│  ├─ config/
│  │  ├─ stripe.js       # Initialises Stripe SDK
│  │  ├─ cloudinary.js   # Uploads images to Cloudinary
│  │  ├─ printful.js     # Sends orders to Printful API
│  │  └─ money.js        # Helpers for price/fee calculations
│  └─ ...
├─ views/
│  ├─ store.ejs          # Landing page and product grid
│  ├─ product.ejs        # Individual product detail page
│  ├─ success.ejs        # Checkout success page
│  ├─ cancel.ejs         # Checkout cancellation page
│  └─ admin/             # Contains EJS templates for dashboard, login, product editor, codes, orders, settings
├─ public/
│  ├─ style.css          # Global styles and CSS variables
│  └─ ...                # Static assets (images, icons)
└─ package-lock.json

Required environment variables

The application uses environment variables loaded via dotenv. Create a .env file (not committed) with at least the following keys:

PORT – port number for Express (defaults to 10000).

NODE_ENV – set to production for HTTPS enforcement and strict CSP; use development locally.

MONGODB_URI – MongoDB connection string.

ADMIN_EMAIL / ADMIN_PASSWORD – credentials used to auto‑create the initial admin account at startup.

JWT_SECRET – secret key for signing admin JWT cookies.

STRIPE_SECRET_KEY – private Stripe API key.

STRIPE_WEBHOOK_SECRET – webhook signing secret from Stripe dashboard.

PRINTFUL_API_KEY – API key for Printful order fulfilment.

CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET – Cloudinary credentials.

CLOUDINARY_FOLDER – optional Cloudinary folder prefix for uploads (default imprev‑clothing).

BASE_URL – public base URL (used by the checkout route when constructing success/cancel URLs). If omitted, it is derived from the incoming request headers.

Running locally

Clone the repository and install dependencies:

git clone https://github.com/CeoSolace/imprev-store.git
cd imprev-store
npm install


Create a .env file in the project root and set the environment variables described above. For local testing you can use a free MongoDB Atlas cluster, Stripe test keys and a Printful API key.

Start the server:

npm start


The app will be available at http://localhost:10000/ unless another port is specified. Log in to /admin/login using the credentials from your .env.

Customising and extending the system

Below are some pointers for adding or modifying features. These are useful if you want to instruct an AI to make targeted changes.

Adding new product fields or variant attributes

Update the Product schema in src/models/Product.js to include the new field. Remember to adjust the VariantSchema if the attribute belongs to variants (e.g., colour or material).

If the field should be editable in the admin UI, modify the relevant EJS template in views/admin/product_edit.ejs and handle the form data in the corresponding POST route in src/routes/admin.js.

When processing checkout, reference the new field in src/routes/public.js to validate and pass it to Stripe metadata if necessary.

Changing price logic or adding new regions

The priceToHitProfit() helper in src/config/money.js determines the retail price needed to achieve a target profit given Stripe fees and costs. Modify this function to adjust rounding behaviour or incorporate additional fees.

Region‑to‑country mapping is defined in regionFromCountry() in the same file. To support additional regions, extend the ALLOWED_SHIP_COUNTRIES array and update regionFromCountry() accordingly.

Stripe fee models are stored in the Settings document. The admin settings page (/admin/settings) lets you edit currencies, percentage and fixed fees for UK, EU, US, TR and ROW. If you add a region, update src/models/Settings.js and the settings route in src/routes/admin.js.

Integrating another payment or fulfilment provider

Payment processing is encapsulated in src/routes/public.js (creation of Stripe sessions) and src/routes/webhooks.js (handling Stripe webhooks). To integrate a different provider, add a new route that calls the provider’s API to create a checkout session and update the webhook handler to listen for that provider’s notifications.

Order fulfilment is abstracted in src/config/printful.js. To fulfil orders via another service or your own warehouse, replace the printfulCreateOrder() function with calls to your provider. Adjust the webhook handler to update order status accordingly.

Styling and front‑end changes

Global styles live in public/style.css. CSS variables at the top define colours, spacing and typography; updating these will propagate throughout the EJS templates.

Layout, content and markup are defined in views/ (for customers) and views/admin/ (for admins). Modify these templates to change the look and feel, add pages or alter the admin dashboard. Remember to preserve form names/IDs used by the routes, or update the route handlers accordingly.

If you add client‑side interactivity, place scripts under public/ and reference them in the corresponding EJS template.

Security considerations

Helmet’s Content Security Policy (CSP) is configured in server.js. If you load assets from new domains (e.g., a different payment provider), update the CSP directives accordingly.

Rate limiting is applied globally and on sensitive endpoints (/admin/login, /checkout). Adjust limits in server.js via the express-rate-limit settings if your traffic pattern changes.

Admin sessions are stored in an HTTP‑only cookie containing a signed JWT. Changing the signing algorithm or expiry requires modifications to src/middleware/jwt.js.

Deploying on Render

The provided render.yaml declares a web service named imprev‑clothing. Render builds the app with npm install and starts it with npm start. Set environment variables in the Render dashboard to match your .env. Ensure the webhook endpoint (/webhooks/stripe) is publicly reachable so Stripe can send events.
