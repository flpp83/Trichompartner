# Shopify Migration Bundle

Ten katalog zawiera gotowy pakiet do przeniesienia wdrożenia na inny sklep Shopify.

## Co jest w środku

- `theme/` - pełny snapshot motywu wyeksportowanego z obecnego sklepu
- `content/pages.json` - strony CMS z treścią
- `content/menus.json` - menu
- `content/blogs.json` - blogi
- `content/articles.json` - artykuły
- `content/products.json` - produkty
- `content/custom-collections.json` - kolekcje manualne
- `content/smart-collections.json` - kolekcje automatyczne
- `content/collects.json` - przypisania produktów do kolekcji manualnych
- `content/redirects.json` - redirecty
- `manifest.json` - raport z eksportu i ewentualnych ograniczeń scope
- `scripts/import-shopify-bundle.mjs` - importer do nowego sklepu

## Co importer robi

- tworzy nowy motyw `unpublished`, jeśli nie podasz `SHOPIFY_THEME_ID`
- albo wgrywa pliki do istniejącego motywu, jeśli podasz `SHOPIFY_THEME_ID`
- importuje strony z `pages.json`
- importuje blogi i artykuły
- importuje menu z `menus.json`
- importuje produkty
- importuje kolekcje manualne i automatyczne
- odtwarza przypisania produktów do kolekcji manualnych
- importuje redirecty

## Czego ten pakiet nadal nie przenosi w pelni automatycznie

- klientów
- zamówień
- plików z panelu `Content > Files`
- inventory levels w wielu lokalizacjach
- ustawienia nawigacji przypisanej ręcznie w edytorze motywu
- zakresów, których nie pozwolil odczytać token źródłowy lub zapisać token docelowy

## Jak uruchomić import na sklepie klienta

Przejdź do katalogu z paczką i uruchom:

```bash
SHOPIFY_SHOP='adres-klienta.myshopify.com' \
SHOPIFY_TOKEN='shpat_xxx' \
node scripts/import-shopify-bundle.mjs
```

Jeśli chcesz wgrać do konkretnego motywu zamiast tworzyć nowy:

```bash
SHOPIFY_SHOP='adres-klienta.myshopify.com' \
SHOPIFY_TOKEN='shpat_xxx' \
SHOPIFY_THEME_ID='123456789' \
node scripts/import-shopify-bundle.mjs
```

Jeśli chcesz uruchomić tylko część importu:

```bash
SHOPIFY_SHOP='adres-klienta.myshopify.com' \
SHOPIFY_TOKEN='shpat_xxx' \
SHOPIFY_IMPORT_PARTS='theme,pages,menus' \
node scripts/import-shopify-bundle.mjs
```

## Uwagi

- importer pomija `template_suffix` strony, jeśli w motywie nie ma odpowiadającego mu template
- w tym snapshotcie istnieje strona `contact` oraz osobna strona `kontakt`
- po imporcie trzeba jeszcze sprawdzić ustawienia motywu w `Theme settings` i przypięcie menu w edytorze Shopify
- jeśli `manifest.json` pokazuje błąd dla `products` lub `collections`, obecny token źródłowy nie miał odpowiedniego scope do pełnego eksportu tych danych
