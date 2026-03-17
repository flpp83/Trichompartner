#!/usr/bin/env node

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const SHOP = process.env.SHOPIFY_SHOP;
const TOKEN = process.env.SHOPIFY_TOKEN;
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-01';
const BUNDLE_ROOT = process.env.SHOPIFY_BUNDLE_ROOT || path.resolve(process.cwd(), 'shopify-migration-bundle');
const THEME_ROOT = path.join(BUNDLE_ROOT, 'theme');
const CONTENT_ROOT = path.join(BUNDLE_ROOT, 'content');
const IMPORT_PARTS = new Set(
  (process.env.SHOPIFY_IMPORT_PARTS || 'theme,pages,blogs,menus,products,collections,redirects')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
);
const TEXT_EXTENSIONS = new Set(['.css', '.js', '.json', '.liquid', '.svg', '.txt']);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pick(source, keys) {
  const target = {};
  for (const key of keys) {
    if (source[key] !== undefined && source[key] !== null) {
      target[key] = source[key];
    }
  }
  return target;
}

function optionSignature(input) {
  return [input.sku || '', input.option1 || '', input.option2 || '', input.option3 || ''].join('||');
}

async function collectFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(fullPath)));
    } else {
      files.push(fullPath);
    }
  }

  return files;
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if (fallback !== null && error.code === 'ENOENT') {
      return fallback;
    }
    throw error;
  }
}

async function restRequest(endpoint, options = {}) {
  const response = await fetch(`https://${SHOP}/admin/api/${API_VERSION}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': TOKEN,
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new Error(`Shopify REST ${response.status}: ${text}`);
  }

  return data;
}

async function graphqlRequest(query, variables = {}) {
  const response = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(`Shopify GraphQL ${response.status}: ${JSON.stringify(payload)}`);
  }

  if (payload.errors?.length) {
    throw new Error(`GraphQL errors: ${JSON.stringify(payload.errors)}`);
  }

  return payload.data;
}

async function ensureTheme() {
  if (process.env.SHOPIFY_THEME_ID) {
    const data = await restRequest(`/themes/${process.env.SHOPIFY_THEME_ID}.json`);
    return data.theme;
  }

  const meta = await readJson(path.join(THEME_ROOT, '_meta', 'theme.json'));
  const data = await restRequest('/themes.json', {
    method: 'POST',
    body: JSON.stringify({
      theme: {
        name: process.env.SHOPIFY_THEME_NAME || `${meta.name || 'Imported theme'} copy`,
        role: 'unpublished',
      },
    }),
  });

  return data.theme;
}

async function uploadAsset(themeId, filePath) {
  const relativeKey = path.relative(THEME_ROOT, filePath).split(path.sep).join('/');
  if (relativeKey.startsWith('_meta/')) return;

  const extension = path.extname(filePath).toLowerCase();
  const content = await readFile(filePath);
  const asset = { key: relativeKey };

  if (TEXT_EXTENSIONS.has(extension)) {
    asset.value = content.toString('utf8');
  } else {
    asset.attachment = content.toString('base64');
  }

  await restRequest(`/themes/${themeId}/assets.json`, {
    method: 'PUT',
    body: JSON.stringify({ asset }),
  });

  console.log(`uploaded asset: ${relativeKey}`);
}

async function importTheme() {
  const theme = await ensureTheme();
  const files = await collectFiles(THEME_ROOT);

  for (const filePath of files) {
    await uploadAsset(theme.id, filePath);
    await sleep(150);
  }

  console.log(`theme ready: ${theme.name} (${theme.id})`);
  return theme;
}

async function listPageTemplateSuffixes() {
  const files = await collectFiles(path.join(THEME_ROOT, 'templates'));
  const suffixes = new Set();

  for (const filePath of files) {
    const relativePath = path.relative(path.join(THEME_ROOT, 'templates'), filePath).split(path.sep).join('/');
    const match = relativePath.match(/^page\.([^.]+)\.json$/);
    if (match) suffixes.add(match[1]);
  }

  return suffixes;
}

async function findPageByHandle(handle) {
  const data = await restRequest(`/pages.json?handle=${encodeURIComponent(handle)}`);
  return data.pages?.[0] || null;
}

function sanitizePagePayload(page, validSuffixes) {
  const payload = {
    title: page.title,
    handle: page.handle,
    body_html: page.body_html || '',
    published: true,
  };

  if (page.template_suffix && validSuffixes.has(page.template_suffix)) {
    payload.template_suffix = page.template_suffix;
  }

  return payload;
}

async function upsertPage(page, validSuffixes) {
  const existing = await findPageByHandle(page.handle);
  const payload = sanitizePagePayload(page, validSuffixes);

  if (existing) {
    const data = await restRequest(`/pages/${existing.id}.json`, {
      method: 'PUT',
      body: JSON.stringify({ page: { ...payload, id: existing.id } }),
    });
    console.log(`updated page: ${data.page.handle}`);
    return data.page;
  }

  const data = await restRequest('/pages.json', {
    method: 'POST',
    body: JSON.stringify({ page: payload }),
  });
  console.log(`created page: ${data.page.handle}`);
  return data.page;
}

async function importPages() {
  const pages = await readJson(path.join(CONTENT_ROOT, 'pages.json'), []);
  const validSuffixes = await listPageTemplateSuffixes();
  const importedPages = new Map();

  for (const page of pages) {
    const imported = await upsertPage(page, validSuffixes);
    importedPages.set(imported.handle, imported);
  }

  return importedPages;
}

async function listBlogs() {
  const data = await restRequest('/blogs.json?limit=250');
  return data.blogs || [];
}

async function findArticle(blogId, handle) {
  const data = await restRequest(`/blogs/${blogId}/articles.json?limit=250&handle=${encodeURIComponent(handle)}`);
  return data.articles?.[0] || null;
}

function sanitizeBlogPayload(blog) {
  return pick(blog, ['title', 'handle', 'commentable', 'feedburner']);
}

function sanitizeArticlePayload(article) {
  const payload = pick(article, [
    'title',
    'handle',
    'author',
    'body_html',
    'summary_html',
    'tags',
    'published',
    'published_at',
    'template_suffix',
  ]);
  if (payload.published === undefined) payload.published = true;
  return payload;
}

async function upsertBlog(blog) {
  const existing = (await listBlogs()).find((entry) => entry.handle === blog.handle);
  const payload = sanitizeBlogPayload(blog);

  if (existing) {
    const data = await restRequest(`/blogs/${existing.id}.json`, {
      method: 'PUT',
      body: JSON.stringify({ blog: { ...payload, id: existing.id } }),
    });
    console.log(`updated blog: ${data.blog.handle}`);
    return data.blog;
  }

  const data = await restRequest('/blogs.json', {
    method: 'POST',
    body: JSON.stringify({ blog: payload }),
  });
  console.log(`created blog: ${data.blog.handle}`);
  return data.blog;
}

async function upsertArticle(blogId, article) {
  const existing = await findArticle(blogId, article.handle);
  const payload = sanitizeArticlePayload(article);

  if (existing) {
    const data = await restRequest(`/blogs/${blogId}/articles/${existing.id}.json`, {
      method: 'PUT',
      body: JSON.stringify({ article: { ...payload, id: existing.id } }),
    });
    console.log(`updated article: ${data.article.handle}`);
    return data.article;
  }

  const data = await restRequest(`/blogs/${blogId}/articles.json`, {
    method: 'POST',
    body: JSON.stringify({ article: payload }),
  });
  console.log(`created article: ${data.article.handle}`);
  return data.article;
}

async function importBlogsAndArticles() {
  const blogs = await readJson(path.join(CONTENT_ROOT, 'blogs.json'), []);
  const articles = await readJson(path.join(CONTENT_ROOT, 'articles.json'), []);
  const importedBlogs = new Map();

  for (const blog of blogs) {
    const imported = await upsertBlog(blog);
    importedBlogs.set(imported.handle, imported);
  }

  for (const article of articles) {
    const blog = importedBlogs.get(article.blog_handle);
    if (!blog) {
      console.warn(`warning: pomijam artykul ${article.handle}, bo brak bloga ${article.blog_handle}`);
      continue;
    }
    await upsertArticle(blog.id, article);
  }

  return importedBlogs;
}

async function listMenus() {
  const data = await graphqlRequest(
    `query ListMenus($first: Int!, $after: String) {
      menus(first: $first, after: $after) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          id
          handle
          title
        }
      }
    }`,
    { first: 50, after: null }
  );

  return data.menus.nodes;
}

function extractHandleFromPageUrl(url) {
  const match = url?.match(/\/pages\/([^/?#]+)/);
  return match ? match[1] : null;
}

async function hydrateMenuItems(items, importedPages) {
  const hydrated = [];

  for (const item of items) {
    const payload = {
      title: item.title,
      type: item.type,
      url: item.url,
      items: [],
    };

    if (item.type === 'PAGE') {
      const handle = extractHandleFromPageUrl(item.url);
      const page = handle ? importedPages.get(handle) : null;
      if (!page) {
        throw new Error(`Brak strony dla menu item ${item.title} (${item.url})`);
      }
      payload.resourceId = `gid://shopify/Page/${page.id}`;
    }

    hydrated.push(payload);
  }

  return hydrated;
}

async function updateMenu(id, title, handle, items) {
  const data = await graphqlRequest(
    `mutation UpdateMenu($id: ID!, $title: String!, $handle: String!, $items: [MenuItemUpdateInput!]!) {
      menuUpdate(id: $id, title: $title, handle: $handle, items: $items) {
        menu { id handle title }
        userErrors { field message }
      }
    }`,
    { id, title, handle, items }
  );

  const errors = data.menuUpdate.userErrors || [];
  if (errors.length) {
    throw new Error(`menuUpdate ${handle}: ${errors.map((error) => error.message).join('; ')}`);
  }
}

async function createMenu(title, handle, items) {
  const data = await graphqlRequest(
    `mutation CreateMenu($title: String!, $handle: String!, $items: [MenuItemCreateInput!]!) {
      menuCreate(title: $title, handle: $handle, items: $items) {
        menu { id handle title }
        userErrors { field message }
      }
    }`,
    { title, handle, items }
  );

  const errors = data.menuCreate.userErrors || [];
  if (errors.length) {
    throw new Error(`menuCreate ${handle}: ${errors.map((error) => error.message).join('; ')}`);
  }
}

async function importMenus(importedPages) {
  const menus = await readJson(path.join(CONTENT_ROOT, 'menus.json'), []);
  const existingMenus = await listMenus();

  for (const menu of menus) {
    if (menu.handle === 'customer-account-main-menu') {
      console.warn(`warning: pomijam systemowe menu ${menu.handle}`);
      continue;
    }

    const items = await hydrateMenuItems(menu.items || [], importedPages);
    const existing = existingMenus.find((entry) => entry.handle === menu.handle);

    if (existing) {
      await updateMenu(existing.id, menu.title, menu.handle, items);
      console.log(`updated menu: ${menu.handle}`);
    } else {
      await createMenu(menu.title, menu.handle, items);
      console.log(`created menu: ${menu.handle}`);
    }
  }
}

async function findProductByHandle(handle) {
  const data = await restRequest(`/products.json?handle=${encodeURIComponent(handle)}&status=any`);
  return data.products?.[0] || null;
}

function sanitizeImage(image) {
  const payload = pick(image, ['src', 'alt', 'position']);
  if (!payload.src && image?.src) payload.src = image.src;
  return payload;
}

function sanitizeVariant(variant, existingVariantMap = new Map()) {
  const payload = pick(variant, [
    'title',
    'price',
    'sku',
    'position',
    'compare_at_price',
    'option1',
    'option2',
    'option3',
    'taxable',
    'barcode',
    'grams',
    'weight',
    'weight_unit',
    'inventory_management',
    'inventory_policy',
    'fulfillment_service',
    'requires_shipping',
  ]);
  const existing = existingVariantMap.get(optionSignature(variant));
  if (existing) payload.id = existing.id;
  return payload;
}

function sanitizeProductPayload(product, existing = null) {
  const existingVariantMap = new Map(
    (existing?.variants || []).map((variant) => [optionSignature(variant), variant])
  );

  const payload = pick(product, [
    'title',
    'handle',
    'body_html',
    'vendor',
    'product_type',
    'status',
    'tags',
    'template_suffix',
    'published_scope',
  ]);

  payload.options = (product.options || []).map((option) => pick(option, ['name', 'position', 'values']));
  payload.variants = (product.variants || []).map((variant) => sanitizeVariant(variant, existingVariantMap));
  payload.images = (product.images || []).map(sanitizeImage).filter((image) => image.src);

  return payload;
}

async function upsertProduct(product) {
  const existing = await findProductByHandle(product.handle);
  const payload = sanitizeProductPayload(product, existing);

  if (existing) {
    const data = await restRequest(`/products/${existing.id}.json`, {
      method: 'PUT',
      body: JSON.stringify({ product: { ...payload, id: existing.id } }),
    });
    console.log(`updated product: ${data.product.handle}`);
    return { source_id: product.id, target: data.product };
  }

  const data = await restRequest('/products.json', {
    method: 'POST',
    body: JSON.stringify({ product: payload }),
  });
  console.log(`created product: ${data.product.handle}`);
  return { source_id: product.id, target: data.product };
}

async function importProducts() {
  const products = await readJson(path.join(CONTENT_ROOT, 'products.json'), []);
  const importedProducts = new Map();

  for (const product of products) {
    const imported = await upsertProduct(product);
    importedProducts.set(product.id, imported.target);
  }

  return importedProducts;
}

async function findCustomCollectionByHandle(handle) {
  const data = await restRequest(`/custom_collections.json?handle=${encodeURIComponent(handle)}`);
  return data.custom_collections?.[0] || null;
}

async function findSmartCollectionByHandle(handle) {
  const data = await restRequest(`/smart_collections.json?handle=${encodeURIComponent(handle)}`);
  return data.smart_collections?.[0] || null;
}

function sanitizeCollectionImage(image) {
  return image ? pick(image, ['src', 'alt']) : undefined;
}

function sanitizeCustomCollectionPayload(collection) {
  const payload = pick(collection, [
    'title',
    'handle',
    'body_html',
    'sort_order',
    'published',
    'published_scope',
    'template_suffix',
  ]);
  if (collection.image?.src) payload.image = sanitizeCollectionImage(collection.image);
  return payload;
}

function sanitizeSmartCollectionPayload(collection) {
  const payload = sanitizeCustomCollectionPayload(collection);
  payload.rules = collection.rules || [];
  if (collection.disjunctive !== undefined) payload.disjunctive = collection.disjunctive;
  return payload;
}

async function upsertCustomCollection(collection) {
  const existing = await findCustomCollectionByHandle(collection.handle);
  const payload = sanitizeCustomCollectionPayload(collection);

  if (existing) {
    const data = await restRequest(`/custom_collections/${existing.id}.json`, {
      method: 'PUT',
      body: JSON.stringify({ custom_collection: { ...payload, id: existing.id } }),
    });
    console.log(`updated custom collection: ${data.custom_collection.handle}`);
    return data.custom_collection;
  }

  const data = await restRequest('/custom_collections.json', {
    method: 'POST',
    body: JSON.stringify({ custom_collection: payload }),
  });
  console.log(`created custom collection: ${data.custom_collection.handle}`);
  return data.custom_collection;
}

async function upsertSmartCollection(collection) {
  const existing = await findSmartCollectionByHandle(collection.handle);
  const payload = sanitizeSmartCollectionPayload(collection);

  if (existing) {
    const data = await restRequest(`/smart_collections/${existing.id}.json`, {
      method: 'PUT',
      body: JSON.stringify({ smart_collection: { ...payload, id: existing.id } }),
    });
    console.log(`updated smart collection: ${data.smart_collection.handle}`);
    return data.smart_collection;
  }

  const data = await restRequest('/smart_collections.json', {
    method: 'POST',
    body: JSON.stringify({ smart_collection: payload }),
  });
  console.log(`created smart collection: ${data.smart_collection.handle}`);
  return data.smart_collection;
}

async function listCollectsForCollection(collectionId) {
  const data = await restRequest(`/collects.json?limit=250&collection_id=${collectionId}`);
  return data.collects || [];
}

async function ensureCollect(collectionId, productId) {
  const existing = await listCollectsForCollection(collectionId);
  if (existing.some((collect) => String(collect.product_id) === String(productId))) {
    return;
  }
  await restRequest('/collects.json', {
    method: 'POST',
    body: JSON.stringify({ collect: { collection_id: collectionId, product_id: productId } }),
  });
}

async function importCollections(importedProducts) {
  const customCollections = await readJson(path.join(CONTENT_ROOT, 'custom-collections.json'), []);
  const smartCollections = await readJson(path.join(CONTENT_ROOT, 'smart-collections.json'), []);
  const collects = await readJson(path.join(CONTENT_ROOT, 'collects.json'), []);
  const importedCollections = new Map();

  for (const collection of customCollections) {
    const imported = await upsertCustomCollection(collection);
    importedCollections.set(collection.id, imported);
  }

  for (const collection of smartCollections) {
    const imported = await upsertSmartCollection(collection);
    importedCollections.set(collection.id, imported);
  }

  for (const collect of collects) {
    const collection = importedCollections.get(collect.collection_id);
    const product = importedProducts.get(collect.product_id);
    if (!collection || !product) continue;
    await ensureCollect(collection.id, product.id);
  }
}

async function findRedirectByPath(pathValue) {
  const data = await restRequest(`/redirects.json?limit=250&path=${encodeURIComponent(pathValue)}`);
  return (data.redirects || []).find((redirect) => redirect.path === pathValue) || null;
}

async function upsertRedirect(redirect) {
  const existing = await findRedirectByPath(redirect.path);
  const payload = pick(redirect, ['path', 'target']);

  if (existing) {
    const data = await restRequest(`/redirects/${existing.id}.json`, {
      method: 'PUT',
      body: JSON.stringify({ redirect: { ...payload, id: existing.id } }),
    });
    console.log(`updated redirect: ${data.redirect.path}`);
    return;
  }

  const data = await restRequest('/redirects.json', {
    method: 'POST',
    body: JSON.stringify({ redirect: payload }),
  });
  console.log(`created redirect: ${data.redirect.path}`);
}

async function importRedirects() {
  const redirects = await readJson(path.join(CONTENT_ROOT, 'redirects.json'), []);
  for (const redirect of redirects) {
    await upsertRedirect(redirect);
  }
}

async function main() {
  if (!SHOP) fail('Brakuje SHOPIFY_SHOP.');
  if (!TOKEN) fail('Brakuje SHOPIFY_TOKEN.');

  let theme = null;
  let importedPages = new Map();
  let importedProducts = new Map();

  if (IMPORT_PARTS.has('theme')) {
    theme = await importTheme();
  } else if (process.env.SHOPIFY_THEME_ID) {
    theme = await ensureTheme();
  }

  if (IMPORT_PARTS.has('pages')) {
    importedPages = await importPages();
  }

  if (IMPORT_PARTS.has('blogs')) {
    await importBlogsAndArticles();
  }

  if (IMPORT_PARTS.has('products')) {
    importedProducts = await importProducts();
  }

  if (IMPORT_PARTS.has('collections')) {
    await importCollections(importedProducts);
  }

  if (IMPORT_PARTS.has('menus')) {
    await importMenus(importedPages);
  }

  if (IMPORT_PARTS.has('redirects')) {
    await importRedirects();
  }

  if (theme) {
    console.log(`theme_id=${theme.id}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
