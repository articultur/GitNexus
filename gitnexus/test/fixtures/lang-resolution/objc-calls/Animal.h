// Animal.h — base class with a protocol
#import <Foundation/Foundation.h>

@protocol Speakable <NSObject>
- (NSString *)speak;
@end

@interface Animal : NSObject <Speakable>
@property (nonatomic, strong) NSString *name;
- (instancetype)initWithName:(NSString *)name;
- (void)eat;
@end
