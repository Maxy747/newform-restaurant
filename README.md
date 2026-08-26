# 🍽️ NEWFORM Multi Cuisine Restaurant

<div align="center">

![NEWFORM Logo](assets/newform_logo.png)

### Authentic Arabian & Kerala Multi-Cuisine | Kakkavayal, Kalpetta, Wayanad

[![Live Site](https://img.shields.io/badge/🌐_Live_Site-Visit_Now-2a9d8f?style=for-the-badge)](https://juuder.github.io/newform-restaurant/)
[![PWA Ready](https://img.shields.io/badge/PWA-Ready-52796f?style=for-the-badge&logo=pwa)](https://juuder.github.io/newform-restaurant/)
[![WhatsApp Orders](https://img.shields.io/badge/WhatsApp-Order_Now-25D366?style=for-the-badge&logo=whatsapp)](https://wa.me/917593881112)

</div>

---

## 🌐 Live Website

> **👉 [https://juuder.github.io/newform-restaurant/](https://juuder.github.io/newform-restaurant/)**

---

## 🏠 About NEWFORM Restaurant

**NEWFORM Multi Cuisine Restaurant** is a beloved dining destination located in **Kakkavayal, Kalpetta, Wayanad, Kerala**. Known for its authentic blend of **Arabian and Kerala cuisine**, NEWFORM has become a landmark for food lovers across Wayanad.

We specialize in slow-cooked **Yemeni-style Mandhi**, charcoal-grilled **Alfaham**, traditional **Kerala Beef Ularthiyathu**, and a wide range of multicuisine delights — all prepared fresh with premium spices and authentic recipes.

### 📍 Location
**Kakkavayal, Kalpetta, Wayanad, Kerala, India**

### 📞 Contact
| Purpose | Number |
|---|---|
| Orders & Delivery | [7593 881 112](tel:7593881112) |
| Catering & Events | [7593 881 113](tel:7593881113) |
| WhatsApp Orders | [+91 75938 81112](https://wa.me/917593881112) |

---

## ✨ App Features

| Feature | Description |
|---|---|
| 🍖 **Full Digital Menu** | Categorized menu with dish descriptions, tags & pricing |
| 🛒 **Smart Cart System** | Add items, select portions (Quarter/Half/Full), manage quantities |
| 📱 **WhatsApp Ordering** | One-tap order via WhatsApp with full order summary |
| 🌙 **Dark / Light Theme** | Minimalist dark (Obsidian) and light themes with toggle |
| 🔍 **Search & Filter** | Search by name, filter by category & diet (Veg / Non-Veg) |
| 🔐 **Admin Panel** | PIN-protected admin mode to add/delete menu items live |
| 📲 **PWA Support** | Installable as a mobile app (Progressive Web App) |
| 💾 **Offline Ready** | Service Worker caches menu for offline browsing |
| 🧾 **GST Calculation** | Automatic 5% GST computed in cart |
| 🚚 **Free Delivery Info** | Free delivery within Kalpetta city for orders above ₹300 |

---

## 🍽️ Menu Categories

| Category | Highlights |
|---|---|
| 🥘 **Mandhi & Rice** | Chicken Mandhi, Alfaham Mandhi, Beef Ribs Mandhi, Pothinkal Mandhi |
| 🔥 **Broast & Alfaham** | Alfaham Chicken, Peri Peri Alfaham, Shawaya Chicken |
| 🥩 **Beef Specials** | Beef Fry (Ularthiyathu), Beef Chilly, Beef Roast |
| 🍗 **Chicken** | Butter Chicken, Chicken Curries, Chinese Chicken |
| 🦐 **Seafood & Prawns** | Prawns Varattu, Fish Curry, Seafood Specials |
| 🐑 **Mutton** | Mutton Curry, Mutton Fry |
| 🥦 **Vegetarian** | Paneer Butter Masala, Veg Curries |
| 🥚 **Kada & Egg** | Country Chicken (Kada) Specials, Egg dishes |

### 💰 Portion Sizes
Most non-veg items are available in:
- **Quarter** — Small portion (ideal for 1 person)
- **Half** — Medium portion (ideal for 2 persons)
- **Full** — Large portion (ideal for 3–4 persons)

---

## 🚚 Services

### 🛵 Home Delivery
- **FREE delivery** within Kalpetta city limits for orders above ₹300
- Call **7593 881 112** or order via WhatsApp

### 🎪 Outdoor Catering
- Specially undertaken for **tour packages**, **events**, **weddings**, and **functions**
- Contact us at **7593 881 113** for catering inquiries

### 📞 Hotline Orders
- Quick phone orders accepted: **7593 881 112 / 7593 881 113**

---

## 🛠️ Tech Stack

| Technology | Usage |
|---|---|
| **HTML5** | Semantic markup & structure |
| **Vanilla CSS** | Custom design system, glassmorphism, animations |
| **JavaScript (ES6+)** | App logic, state management, dynamic rendering |
| **LocalStorage API** | Cart and theme persistence |
| **Supabase** | Auth, menu data, and menu-image storage |
| **Service Worker** | PWA offline caching |
| **GitHub Pages** | Free static site hosting |
| **WhatsApp API** | Direct order messaging (`wa.me`) |
| **Font Awesome 6** | Icons throughout the UI |

---

## 🚀 Getting Started (Local Development)

```bash
# Clone the repository
git clone https://github.com/JUUDER/newform-restaurant.git

# Navigate to folder
cd newform-restaurant

# Run a local server (Python)
python -m http.server 8000

# Open in browser
# http://localhost:8000
```

---

## 📁 Project Structure

```
newform-restaurant/
├── index.html          # Main HTML — layout & modals
├── app.js              # Core app logic — menu, cart, admin, ordering
├── styles.css          # Full design system — dark/light themes, animations
├── sw.js               # Service Worker — PWA offline support
├── manifest.json       # PWA manifest — app name, icons, theme
├── README.md           # This file
└── assets/
    ├── newform_logo.png    # Official restaurant logo
    ├── mandhi.png          # Mandhi rice platter image
    ├── alfaham.png         # Alfaham chicken image
    ├── beeffry.png         # Beef fry/roast image
    └── hero.png            # Hero section food image
```

---

## 🔐 Admin Panel and Supabase setup

The dashboard keeps the existing UI, now backed by Supabase email/password authentication. Admins can add, edit, delete, and upload dish images; customers can only read the menu.

1. Create a Supabase project and run [supabase_schema.sql](supabase_schema.sql) in its SQL Editor.
2. Create the restaurant administrator in **Authentication → Users**, then run the commented promotion query at the end of the SQL file with that email.
3. Copy `.env.example` to `.env` for local development and set the project URL and anon key. Never put a service-role key in the frontend.
4. In GitHub, set `VITE_SUPABASE_URL` and `VITE_SUPABASE_PUBLISHABLE_KEY` as repository Actions secrets. Enable **Settings → Pages → Source: GitHub Actions**. Pushing to `max` deploys the static `dist` folder.

The Supabase publishable key is intentionally included at build time. Database and storage access are protected by Row Level Security and the `profiles.role = 'admin'` policy, not by hiding the key.

---

## 📱 Install as Mobile App (PWA)

1. Open the [live site](https://juuder.github.io/newform-restaurant/) on your phone
2. Tap the **browser menu** (⋮)
3. Select **"Add to Home Screen"** or **"Install App"**
4. The app will install like a native app — works offline too!

---

## 📄 License

This project is built exclusively for **NEWFORM Multi Cuisine Restaurant**, Kalpetta, Wayanad, Kerala.

© 2026 NEWFORM Restaurant. All rights reserved.

---

<div align="center">

**Made with ❤️ for NEWFORM Multi Cuisine Restaurant**

*Kakkavayal, Kalpetta, Wayanad, Kerala*

[🌐 Visit Live Site](https://juuder.github.io/newform-restaurant/) • [📞 Call to Order](tel:7593881112) • [💬 WhatsApp Order](https://wa.me/917593881112)

</div>
