// Dog.m — Dog implementation with cross-file message calls
#import "Dog.h"

@implementation Dog

- (NSString *)speak {
    return @"Woof!";
}

- (void)fetch:(NSString *)item {
    // triggers CALLS edge: [self eat] → Animal.eat
    [self eat];
    NSLog(@"%@ fetched %@", self.name, item);
}

@end
