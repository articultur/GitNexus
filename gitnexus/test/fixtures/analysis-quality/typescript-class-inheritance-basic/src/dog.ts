import { Animal } from './animal';

export class Dog extends Animal {
  breed: string;

  constructor(name: string, breed: string) {
    super(name);
    this.breed = breed;
  }

  speak(): string {
    return `${this.name} barks.`;
  }

  fetch(): string {
    return `${this.name} fetches the ball.`;
  }
}
