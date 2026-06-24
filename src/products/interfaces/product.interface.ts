export interface ProductRecord {
  displayTitle: string;
  embeddingText: string;
  url: string;
  imageUrl: string;
  productType: string;
  discount: string;
  price: string;
  variants: string;
  createDate: string;
}

export interface ProductResult {
  name: string;
  description: string;
  price: string;
  priceAmount: number | null;
  currency: string;
  productType: string;
  score: number;
}
