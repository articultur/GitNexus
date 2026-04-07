/**
 * ArkUI page fixture — HarmonyOS component with structs, decorators, and state.
 * Used by tree-sitter-languages.test.ts for ArkTS decorator and struct capture tests.
 *
 * Note: `struct` is preprocessed to `class` before parsing with TypeScript grammar.
 */

import http from '@ohos.net.http';

interface Product {
  id: number;
  name: string;
  price: number;
}

@Component
struct ProductCard {
  name: string = '';
  price: number = 0;

  build() {
    Column() {
      Text(this.name)
        .fontSize(16)
        .fontWeight(FontWeight.Medium);
      Text(`¥${this.price}`)
        .fontSize(14)
        .fontColor('#666666');
    }
    .padding(12)
    .backgroundColor('#FFFFFF')
    .borderRadius(8);
  }
}

@Entry
@Component
struct Index {
  @State message: string = 'Hello HarmonyOS';
  @State products: Product[] = [];

  aboutToAppear() {
    this.loadProducts();
  }

  @Builder
  loadProducts() {
    this.products = [
      { id: 1, name: 'Widget A', price: 9.99 },
      { id: 2, name: 'Widget B', price: 19.99 },
    ];
  }

  build() {
    Column() {
      Text(this.message)
        .fontSize(20)
        .fontWeight(FontWeight.Bold);
      ForEach(this.products, (product: Product) => {
        ProductCard({ name: product.name, price: product.price });
      });
    }
    .width('100%')
    .height('100%');
  }
}
