import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser, type AuthUser } from '../auth/current-user.decorator';
import { AllowExpiredTrial } from '../companies/allow-expired-trial.decorator';
import { CustomersService } from './customers.service';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { ListCustomersDto } from './dto/list-customers.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';

@ApiTags('customers')
@ApiBearerAuth('logto')
@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateCustomerDto) {
    return this.customers.create(user.id, dto);
  }

  @Get()
  @AllowExpiredTrial()
  findAll(@CurrentUser() user: AuthUser, @Query() query: ListCustomersDto) {
    return this.customers.findAll(user.id, query);
  }

  @Get(':id')
  @AllowExpiredTrial()
  findOne(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.customers.findOne(user.id, id);
  }

  @Patch(':id')
  update(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateCustomerDto) {
    return this.customers.update(user.id, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@CurrentUser() user: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.customers.remove(user.id, id);
  }
}
