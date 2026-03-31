// gitnexus/test/fixtures/objective-c/multi-selector-method.m

@interface B2HPageWidget

// Unary method (backward compatibility)
- (instancetype)alloc;

// Class method
+ (instancetype)new;

// Multi-parameter method (core fix target)
- (CGSize)sizeOfView:(id)viewData
                  css:(NSDictionary *)css
             attribute:(NSString *)attr
             superFrame:(CGRect)frame;

// Block parameter
- (void)completion:(void(^)(BOOL success))completion;

// Multi-parameter method
- (void)method:(int)a with:(int)b;

@end

@implementation B2HPageWidget

- (instancetype)alloc {
}

+ (instancetype)new {
  return [self alloc];
}

- (CGSize)sizeOfView:(id)viewData
                  css:(NSDictionary *)css
           attribute:(NSString *)attr
           superFrame:(CGRect)frame {
  return CGSizeZero;
}

- (void)completion:(void(^)(BOOL success))completion {
  if (completion) completion(YES);
}

- (void)method:(int)a with:(int)b {
}

@end