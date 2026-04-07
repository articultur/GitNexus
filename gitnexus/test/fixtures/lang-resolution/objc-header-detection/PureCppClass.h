// PureCppClass.h
#pragma once
#include <string>
#include <vector>

class PureCppClass {
public:
    PureCppClass() = default;
    ~PureCppClass() = default;

    void doSomething();
    std::string getName() const { return name_; }

private:
    std::string name_;
    std::vector<int> items_;
};
