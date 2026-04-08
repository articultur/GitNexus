// main.m — entry point exercising cross-class message sends
#import "Dog.h"
#import "Animal.h"

int main(int argc, const char *argv[]) {
    @autoreleasepool {
        Animal *animal = [[Animal alloc] initWithName:@"Cat"];
        [animal eat];
        [animal speak];

        Dog *dog = [[Dog alloc] initWithName:@"Rex"];
        [dog speak];
        [dog fetch:@"ball"];
    }
    return 0;
}
