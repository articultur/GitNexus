// Animal.m — base class implementation
#import "Animal.h"

@implementation Animal

- (instancetype)initWithName:(NSString *)name {
    self = [super init];
    if (self) {
        _name = name;
    }
    return self;
}

- (NSString *)speak {
    return @"...";
}

- (void)eat {
    NSLog(@"%@ is eating", _name);
}

@end
