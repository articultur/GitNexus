/**
 * HarmonyOS Index page — demonstrates ArkUI builder DSL.
 * Exercises: @Entry, @Component, @State, @Prop, @Builder, build() method,
 * component tree calls (Column, Row, Text, Button, Image).
 */
import router from '@ohos.router';

interface Product {
  id: number;
  name: string;
  price: number;
}

@Component
struct ProductCard {
  @Prop product: Product;

  build() {
    Column() {
      Text(this.product.name)
        .fontSize(18)
        .fontWeight(FontWeight.Bold)
      Text(`¥${this.product.price}`)
        .fontSize(14)
        .fontColor('#FF666666')
    }
    .padding(12)
    .borderRadius(8)
  }
}

@Entry
@Component
struct Index {
  @State products: Product[] = [
    { id: 1, name: 'HarmonyOS Phone', price: 3999 },
    { id: 2, name: 'HarmonyOS Tablet', price: 2499 },
  ];
  @State selectedId: number = -1;

  @Builder
  headerBuilder() {
    Row() {
      Text('Product Catalog')
        .fontSize(24)
        .fontWeight(FontWeight.Bold)
      Blank()
      Button('Refresh')
        .onClick(() => {
          this.loadProducts();
        })
    }
    .width('100%')
    .padding({ left: 16, right: 16, top: 8, bottom: 8 })
  }

  loadProducts(): void {
    const params = router.getParams() as Record<string, string>;
    const category = params?.['category'] ?? 'all';
    // Real impl would call HttpService.fetchProducts(category)
    console.log(`Loading products for category: ${category}`);
  }

  build() {
    Column() {
      this.headerBuilder()
      List({ space: 8 }) {
        ForEach(this.products, (item: Product) => {
          ListItem() {
            ProductCard({ product: item })
              .onClick(() => {
                this.selectedId = item.id;
              })
          }
        })
      }
      .layoutWeight(1)
      .padding({ left: 16, right: 16 })
    }
    .width('100%')
    .height('100%')
    .backgroundColor('#FFF1F3F5')
  }
}
